import { defineMiddleware } from 'astro:middleware';
import { TOKEN_COOKIE } from './lib/api';

const PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password'];

// Guard SSR: tanpa cookie token → /login. Verifikasi kriptografis tetap di API
// (web tidak pegang JWT_SECRET); ini gate navigasi, bukan gate keamanan data.
export const onRequest = defineMiddleware((ctx, next) => {
  const { pathname } = ctx.url;
  const hasToken = Boolean(ctx.cookies.get(TOKEN_COOKIE)?.value);

  if (!hasToken && !PUBLIC_PATHS.some((p) => pathname.startsWith(p)) && !pathname.startsWith('/api/')) {
    return ctx.redirect('/login');
  }
  if (hasToken && PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return ctx.redirect('/');
  }
  return next();
});
