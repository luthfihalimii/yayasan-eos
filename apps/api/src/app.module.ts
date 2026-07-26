import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './core/all-exceptions.filter';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './core/config';
import { JwtAuthGuard } from './core/auth/jwt-auth.guard';
import { UnitContextInterceptor } from './core/unit-context.interceptor';
import { PrismaService } from './core/prisma.service';
import { AcademicModule } from './modules/academic/academic.module';
import { AuthModule } from './modules/auth/auth.module';
import { PaymentModule } from './modules/payment/payment.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '8h' },
    }),
    // Rate limit global longgar (PRD §5.1) — endpoint kredensial override lebih ketat via @Throttle.
    // Test: dilewati (login berulang antar test = false positive), KECUALI
    // THROTTLE_TEST=1 — dipakai test yang memang menguji rate limit.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }],
      skipIf: () => process.env.NODE_ENV === 'test' && process.env.THROTTLE_TEST !== '1',
    }),
    AcademicModule,
    AuthModule,
    PaymentModule,
  ],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: UnitContextInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [PrismaService],
})
export class AppModule {}
