import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * Transport pluggable — Google Workspace SMTP begitu akun nonprofit approved:
 *   SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USER=noreply@trigunabhakti.or.id
 *   SMTP_PASS=<app password> (akun + 2FA + app password)
 * Naik ke smtp-relay.gmail.com:587 kalau volume Phase 2 (tagihan massal) menuntut.
 * Tanpa SMTP_HOST (dev/CI): log ke console — alur reset tetap bisa diuji penuh.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor() {
    const host = process.env.SMTP_HOST;
    this.from = process.env.SMTP_FROM ?? 'Yayasan EOS <noreply@trigunabhakti.or.id>';
    this.transporter = host
      ? nodemailer.createTransport({
          host,
          port: Number(process.env.SMTP_PORT ?? 465),
          secure: Number(process.env.SMTP_PORT ?? 465) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        })
      : null;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[DEV MAIL] to=${to} subject="${subject}"\n${text}`);
      return;
    }
    await this.transporter.sendMail({ from: this.from, to, subject, text });
  }
}
