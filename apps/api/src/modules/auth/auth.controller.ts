import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../core/auth/decorators';
import type { AuthenticatedRequest } from '../../core/auth/jwt.types';
import { AuthService } from './auth.service';

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
});

const forgotSchema = z.object({ email: emailSchema });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: unknown) {
    const { email, password } = loginSchema.parse(body);
    return this.auth.login(email, password);
  }

  /**
   * Anti user-enumeration: respons SELALU sama, ada atau tidak emailnya.
   * ponytail: pengiriman email reset belum ada (butuh SMTP/provider —
   * keputusan infra); endpoint dipasang sekarang supaya kontrak UI stabil.
   */
  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() body: unknown) {
    forgotSchema.parse(body);
    return { message: 'Jika email terdaftar, instruksi reset telah dikirim.' };
  }

  /** Profil + unit membership untuk header/unit-switcher web. */
  @Get('me')
  me(@Req() req: AuthenticatedRequest) {
    return this.auth.me(req.user.sub);
  }
}
// ponytail: rate limiting login (PRD §5.1) belum dipasang — tambahkan
// @nestjs/throttler saat AppModule dirakit final, sebelum endpoint publik live.
