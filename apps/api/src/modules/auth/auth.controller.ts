import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../core/auth/decorators';
import { AuthService } from './auth.service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: unknown) {
    const { email, password } = loginSchema.parse(body);
    return this.auth.login(email, password);
  }
}
// ponytail: rate limiting login (PRD §5.1) belum dipasang — tambahkan
// @nestjs/throttler saat AppModule dirakit final, sebelum endpoint publik live.
