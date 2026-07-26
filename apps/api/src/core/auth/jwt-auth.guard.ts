import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { CROSS_UNIT_KEY, PUBLIC_KEY, ROLES_KEY } from './decorators';
import { JwtClaims } from './jwt.types';

const CROSS_UNIT_ROLES: Role[] = ['YAYASAN_ADMIN', 'STAFF']; // STAFF = bendahara; sub-role finance menyusul

/**
 * Guard global (AGENTS.md §4.2): verifikasi JWT, validasi active unit ∈
 * memberships, tentukan cross-unit HANYA via @CrossUnit() — bukan blanket
 * role check. Hasilnya ditaruh di req.activeUnitId untuk interceptor ALS.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) throw new UnauthorizedException('Token tidak ada');

    let claims: JwtClaims;
    try {
      claims = await this.jwt.verifyAsync<JwtClaims>(token);
    } catch {
      throw new UnauthorizedException('Token tidak valid');
    }
    req.user = claims;

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (roles && !roles.includes(claims.role)) {
      throw new ForbiddenException('Role tidak diizinkan');
    }

    if (this.reflector.getAllAndOverride<boolean>(CROSS_UNIT_KEY, targets)) {
      if (!CROSS_UNIT_ROLES.includes(claims.role)) {
        throw new ForbiddenException('Endpoint konsolidasi hanya untuk Yayasan Admin/Bendahara');
      }
      req.activeUnitId = null; // → sentinel '__ALL__' di bridge RLS
      return true;
    }

    // Single-unit path: request WAJIB mendeklarasikan active unit, divalidasi membership.
    const requested = (req.headers['x-active-unit'] as string | undefined) ?? claims.unitMemberships[0];
    if (!requested || !claims.unitMemberships.includes(requested)) {
      throw new ForbiddenException('Active unit bukan membership user');
    }
    req.activeUnitId = requested;
    return true;
  }
}
