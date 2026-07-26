import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/prisma.service';
import { JwtClaims } from '../../core/auth/jwt.types';

// PRD §5.1 — Argon2id, parameter minimum OWASP.
export const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

const DUMMY_HASH = argon2.hash('dummy-timing-equalizer', ARGON2_OPTIONS);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  static hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  /**
   * Login = satu-satunya lookup User lintas unit yang sah (master data global,
   * tanpa RLS — AGENTS.md migration note). JWT memuat DAFTAR membership (§4.2).
   */
  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { memberships: { select: { unitId: true } } },
    });
    // Verifikasi tetap jalan pada user tak dikenal — anti user-enumeration via timing.
    // Dummy hash dihitung sekali (module-level), bukan per-request.
    const hash = user?.passwordHash ?? (await DUMMY_HASH);
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Email atau password salah');

    const claims: JwtClaims = {
      sub: user.id,
      role: user.role,
      unitMemberships: user.memberships.map((m) => m.unitId),
    };
    return { accessToken: await this.jwt.signAsync(claims) };
  }
}
