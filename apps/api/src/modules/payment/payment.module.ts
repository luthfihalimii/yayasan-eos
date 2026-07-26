import { Module } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { WebhookInboxService } from './webhook-inbox.service';

@Module({
  controllers: [PaymentController],
  providers: [
    PrismaService,
    PaymentService,
    {
      provide: LedgerService,
      useFactory: (prisma: PrismaService) => new LedgerService(prisma),
      inject: [PrismaService],
    },
    {
      provide: WebhookInboxService,
      useFactory: (prisma: PrismaService, payment: PaymentService) =>
        new WebhookInboxService(prisma, process.env.DOKU_SECRET_KEY ?? '', (inbox) =>
          payment.processCallback(inbox),
        ),
      inject: [PrismaService, PaymentService],
    },
  ],
  exports: [LedgerService],
})
export class PaymentModule {}
