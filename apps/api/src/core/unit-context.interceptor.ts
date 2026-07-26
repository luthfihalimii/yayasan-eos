import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { currentUnitContext } from './unit-context';

/**
 * Menjalankan seluruh handler di dalam ALS scope (AGENTS.md §4.2).
 * Request yang tidak lewat guard (endpoint @Public tanpa set activeUnitId)
 * SENGAJA tidak di-run → getStore() = undefined → withUnitTx fail-closed.
 */
@Injectable()
export class UnitContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if (req.activeUnitId === undefined) return next.handle();
    return currentUnitContext.run(req.activeUnitId, () => next.handle());
  }
}
