import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(async ({mode}) => {
  const env = loadEnv(mode, '.', '');
  const adminProxyTarget = env.VITE_ADMIN_PROXY_TARGET || 'http://localhost:3001';
  const plugins = [react()];

  try {
    const tailwindcss = (await import('@tailwindcss/vite')).default;
    plugins.push(tailwindcss());
  } catch {
    // fallback local: allow dev server even if optional tailwind vite plugin is unavailable
  }

  return {
    plugins,
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          rede: path.resolve(__dirname, 'rede/index.html'),
          desenvolvedor: path.resolve(__dirname, 'desenvolvedor/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        // In local tests, access the POS system through /sistema on the institutional site.
        '/sistema': {
          target: adminProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
