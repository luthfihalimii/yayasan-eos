import { Module } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { MailerService } from '../../core/mailer.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TurnstileService } from './turnstile.service';

@Module({
  controllers: [AuthController],
  providers: [PrismaService, AuthService, MailerService, TurnstileService],
})
export class AuthModule {}
