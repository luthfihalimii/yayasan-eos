import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Runtime = eos_app (DATABASE_URL). Migrasi TIDAK lewat sini (§4.2 poin 4, §4.8).
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ datasources: { db: { url: process.env.DATABASE_URL } } });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
