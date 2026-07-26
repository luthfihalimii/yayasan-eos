import { Module } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { AcademicController } from './academic.controller';
import { AcademicService } from './academic.service';

@Module({
  controllers: [AcademicController],
  providers: [PrismaService, AcademicService],
  exports: [AcademicService],
})
export class AcademicModule {}
