import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { PrismaService } from '../../core/prisma.service';
import { MailerService } from '../../core/mailer.service';
import { decryptSecret, encryptSecret, sha256hex } from '../../core/crypto';
import { JwtClaims } from '../../core/auth/jwt.types';

// PRD §5.1 — Argon2id, parameter minimum OWASP.
export const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 jam
const WEB_URL = () => process.env.WEB_URL ?? 'http://127.0.0.1:4321';

const DUMMY_HASH = argon2.hash('dummy-timing-equalizer', ARGON2_OPTIONS);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mailer: MailerService,
  ) {}

  static hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  private sysTx<T>(fn: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<T>) {
    // Operasi auth = system context (pre-auth / user-global): sentinel eksplisit (§4.2).
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', true)`;
      return fn(tx);
    });
  }

  /**
   * Login system context (§4.2). MFA: kalau TOTP aktif, wajib kirim kode —
   * tanpa kode → 401 ber-flag mfaRequired supaya web menampilkan step kedua.
   */
  async login(email: string, password: string, totpCode?: string): Promise<{ accessToken: string }> {
    const user = await this.sysTx((tx) =>
      tx.user.findUnique({ where: { email }, include: { memberships: { select: { unitId: true } } } }),
    );
    const hash = user?.passwordHash ?? (await DUMMY_HASH);
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Email atau password salah');

    if (user.totpEnabledAt && user.totpSecretEnc) {
      if (!totpCode) {
        throw new UnauthorizedException({ message: 'Kode autentikator dibutuhkan', mfaRequired: true });
      }
      const valid = authenticator.verify({ token: totpCode, secret: decryptSecret(user.totpSecretEnc) });
      if (!valid) throw new UnauthorizedException({ message: 'Kode autentikator salah', mfaRequired: true });
    }

    const claims: JwtClaims = {
      sub: user.id,
      role: user.role,
      unitMemberships: user.memberships.map((m) => m.unitId),
    };
    return { accessToken: await this.jwt.signAsync(claims) };
  }

  /** Selalu sukses diam-diam (anti-enumeration) — email hanya terkirim kalau user ada. */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.sysTx((tx) => tx.user.findUnique({ where: { email } }));
    if (!user) return;

    const token = randomBytes(32).toString('base64url');
    await this.sysTx((tx) =>
      tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256hex(token),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      }),
    );
    await this.mailer.send(
      email,
      'Reset Password — Yayasan EOS',
      `Halo,\n\nKami menerima permintaan reset password akun Anda.\n` +
        `Buka tautan berikut (berlaku 1 jam, sekali pakai):\n\n` +
        `${WEB_URL()}/reset-password?token=${token}\n\n` +
        `Abaikan email ini jika Anda tidak meminta reset.`,
    );
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await this.sysTx((tx) =>
      tx.passwordResetToken.findUnique({ where: { tokenHash: sha256hex(token) } }),
    );
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('Token reset tidak valid atau sudah kadaluarsa');
    }
    const passwordHash = await AuthService.hashPassword(newPassword);
    await this.sysTx(async (tx) => {
      // updateMany + filter usedAt: dua request paralel dengan token sama → satu menang.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException('Token sudah dipakai');
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    });
  }

  // --- MFA TOTP (PRD §5.1 — wajib YAYASAN_ADMIN & bendahara) ---

  /** Generate secret + otpauth URI (QR di web). Belum aktif sampai diverifikasi. */
  async setupTotp(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.sysTx((tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }));
    if (user.totpEnabledAt) throw new BadRequestException('MFA sudah aktif');
    const secret = authenticator.generateSecret();
    await this.sysTx((tx) =>
      tx.user.update({ where: { id: userId }, data: { totpSecretEnc: encryptSecret(secret) } }),
    );
    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, 'Yayasan EOS', secret),
    };
  }

  /** Verifikasi kode pertama → MFA resmi aktif. */
  async enableTotp(userId: string, code: string): Promise<void> {
    const user = await this.sysTx((tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }));
    if (!user.totpSecretEnc) throw new BadRequestException('Jalankan setup dulu');
    if (user.totpEnabledAt) throw new BadRequestException('MFA sudah aktif');
    if (!authenticator.verify({ token: code, secret: decryptSecret(user.totpSecretEnc) })) {
      throw new BadRequestException('Kode salah — scan ulang QR dan coba lagi');
    }
    await this.sysTx((tx) =>
      tx.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } }),
    );
  }

  /** Profil ringkas + daftar unit membership + status MFA. */
  async me(userId: string) {
    const user = await this.sysTx((tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          role: true,
          totpEnabledAt: true,
          memberships: { select: { unit: { select: { id: true, type: true, name: true } } } },
        },
      }),
    );
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      mfaEnabled: Boolean(user.totpEnabledAt),
      units: user.memberships.map((m) => m.unit),
    };
  }
}
