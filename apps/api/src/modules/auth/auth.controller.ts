import { Body, Controller, Get, Ip, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../../core/auth/decorators';
import type { AuthenticatedRequest } from '../../core/auth/jwt.types';
import { AuthService } from './auth.service';
import { TurnstileService } from './turnstile.service';

// REQ bisnis: hanya email domain yayasan yang boleh masuk.
export const ALLOWED_EMAIL_DOMAIN = '@trigunabhakti.or.id';

const emailSchema = z
  .string()
  .email()
  .toLowerCase()
  .refine((e) => e.endsWith(ALLOWED_EMAIL_DOMAIN), {
    message: `Email wajib menggunakan domain ${ALLOWED_EMAIL_DOMAIN}`,
  });

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  turnstileToken: z.string().optional(),
});

const forgotSchema = z.object({ email: emailSchema, turnstileToken: z.string().optional() });

const resetSchema = z.object({
  token: z.string().min(16),
  newPassword: z.string().min(12, 'Password minimal 12 karakter').max(256),
});

const totpSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly turnstile: TurnstileService,
  ) {}

  // Rate limit ketat endpoint kredensial (PRD §5.1) — di atas limit global.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(@Body() body: unknown, @Ip() ip: string) {
    const { email, password, totpCode, turnstileToken } = loginSchema.parse(body);
    await this.turnstile.assertValid(turnstileToken, ip);
    return this.auth.login(email, password, totpCode);
  }

  /** Anti user-enumeration: respons SELALU sama, ada atau tidak emailnya. */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(@Body() body: unknown, @Ip() ip: string) {
    const { email, turnstileToken } = forgotSchema.parse(body);
    await this.turnstile.assertValid(turnstileToken, ip);
    await this.auth.requestPasswordReset(email);
    return { message: 'Jika email terdaftar, instruksi reset telah dikirim.' };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(@Body() body: unknown) {
    const { token, newPassword } = resetSchema.parse(body);
    await this.auth.resetPassword(token, newPassword);
    return { message: 'Password berhasil diubah. Silakan masuk kembali.' };
  }

  // --- MFA (butuh JWT — guard global) ---

  @Post('totp/setup')
  setupTotp(@Req() req: AuthenticatedRequest) {
    return this.auth.setupTotp(req.user.sub);
  }

  @Post('totp/enable')
  async enableTotp(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const { code } = totpSchema.parse(body);
    await this.auth.enableTotp(req.user.sub, code);
    return { message: 'MFA aktif.' };
  }

  /** Profil + unit membership untuk header/unit-switcher web. */
  @Get('me')
  me(@Req() req: AuthenticatedRequest) {
    return this.auth.me(req.user.sub);
  }
}
