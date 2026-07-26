// Klien API server-side (SSR). Token dari cookie httpOnly — tidak pernah di JS klien.
import type { AstroCookies } from 'astro';

const API_URL = import.meta.env.API_URL ?? 'http://127.0.0.1:3000';
export const TOKEN_COOKIE = 'eos_token';
export const UNIT_COOKIE = 'eos_active_unit';

export interface Me {
  id: string;
  email: string;
  role: string;
  units: { id: string; type: string; name: string }[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function api<T>(
  cookies: AstroCookies,
  path: string,
  init?: RequestInit & { unitId?: string },
): Promise<T> {
  const token = cookies.get(TOKEN_COOKIE)?.value;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.unitId ? { 'x-active-unit': init.unitId } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.json() as Promise<T>;
}

/** null = belum login/token kadaluarsa → redirect ke /login oleh middleware. */
export async function getMe(cookies: AstroCookies): Promise<Me | null> {
  if (!cookies.get(TOKEN_COOKIE)?.value) return null;
  try {
    return await api<Me>(cookies, '/auth/me');
  } catch {
    return null;
  }
}

export function resolveActiveUnit(cookies: AstroCookies, me: Me): string | undefined {
  const fromCookie = cookies.get(UNIT_COOKIE)?.value;
  if (fromCookie && me.units.some((u) => u.id === fromCookie)) return fromCookie;
  return me.units[0]?.id;
}
