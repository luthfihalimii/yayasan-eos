import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { currentUnitContext } from './unit-context';

/**
 * Menjalankan seluruh handler di dalam ALS scope (AGENTS.md §4.2).
 * PENTING: next.handle() lazy — Nest men-subscribe SETELAH intercept()
 * return, di luar callback run(). Karena itu subscribe harus terjadi
 * DI DALAM run() supaya handler mewarisi context; kalau tidak, semua
 * request kena fail-closed 403 (getStore() = undefined).
 * Request tanpa activeUnitId (endpoint @Public tanpa guard) SENGAJA
 * tidak di-run → withUnitTx menolak — fail-closed by design.
 */
@Injectable()
export class UnitContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if (req.activeUnitId === undefined) return next.handle();
    return new Observable((subscriber) => {
      const sub = currentUnitContext.run(req.activeUnitId, () =>
        next.handle().subscribe(subscriber),
      );
      return () => sub.unsubscribe();
    });
  }
}
