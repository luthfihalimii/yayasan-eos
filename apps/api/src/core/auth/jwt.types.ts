import { Role } from '@prisma/client';

// AGENTS.md §4.2 — JWT bawa DAFTAR membership, bukan satu unitId.
export interface JwtClaims {
  sub: string; // userId
  role: Role;
  unitMemberships: string[]; // unitId[]
}

export interface AuthenticatedRequest {
  user: JwtClaims;
  /** Active unit hasil validasi guard — string, atau null untuk @CrossUnit. */
  activeUnitId: string | null;
  headers: Record<string, string | string[] | undefined>;
}
