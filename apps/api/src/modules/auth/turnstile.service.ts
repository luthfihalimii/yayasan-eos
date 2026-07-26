import { Injectable, UnauthorizedException } from '@nestjs/common';

// Cloudflare Turnstile siteverify (REQ). Rahasia di env TURNSTILE_SECRET_KEY.
// Tanpa secret (dev/CI/test): verifikasi DILEWATI — set selalu di produksi.
// Test key Cloudflare tersedia: 1x0000000000000000000000000000000AA (always pass).
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

@Injectable()
export class TurnstileService {
  async assertValid(token: string | undefined, remoteIp?: string): Promise<void> {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) return; // dev mode

    if (!token) throw new UnauthorizedException('Verifikasi captcha dibutuhkan');
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: remoteIp }),
    });
    const body = (await res.json()) as { success: boolean };
    if (!body.success) throw new UnauthorizedException('Verifikasi captcha gagal');
  }
}
