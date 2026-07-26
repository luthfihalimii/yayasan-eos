// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// SSR penuh: guard auth jalan di server, JWT di cookie httpOnly — tidak pernah menyentuh JS klien.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // CSRF: checkOrigin bawaan gagal di node standalone tanpa reverse proxy
  // (origin vs URL internal tidak match). Proteksi CSRF ditanggung cookie
  // SameSite=lax (browser tidak melampirkan cookie di cross-site POST) —
  // semua mutasi web pakai form POST + cookie httpOnly, tidak ada bearer di klien.
  security: { checkOrigin: false },
  vite: {
    plugins: [tailwindcss()],
  },
});
