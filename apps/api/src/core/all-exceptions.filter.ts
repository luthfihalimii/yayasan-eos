import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { MissingUnitContextError } from './unit-context';

// AGENTS.md §4.5 — exception filter terpusat. Pemetaan domain → HTTP di satu tempat.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof ZodError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: 400,
        message: 'Validasi gagal',
        issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    if (exception instanceof MissingUnitContextError) {
      res.status(HttpStatus.FORBIDDEN).json({ statusCode: 403, message: exception.message });
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        res.status(HttpStatus.CONFLICT).json({ statusCode: 409, message: 'Data duplikat' });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, message: 'Data tidak ditemukan' });
        return;
      }
    }
    // Jangan bocorkan detail internal (PRD §5.1 — error message tidak leak).
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error' });
  }
}
