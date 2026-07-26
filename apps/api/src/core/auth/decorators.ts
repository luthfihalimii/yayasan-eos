import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const CROSS_UNIT_KEY = 'crossUnit';
/**
 * Endpoint konsolidasi lintas unit (AGENTS.md §4.2) — HANYA Yayasan Admin &
 * Bendahara (staff finance). Context di-set null → sentinel '__ALL__' di RLS.
 * Tanpa decorator ini, SEMUA role (termasuk admin) scoped ke active unit.
 */
export const CrossUnit = () => SetMetadata(CROSS_UNIT_KEY, true);

export const PUBLIC_KEY = 'isPublic';
/** Endpoint tanpa JWT (login, webhook DOKU — webhook diautentikasi signature, bukan JWT). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
