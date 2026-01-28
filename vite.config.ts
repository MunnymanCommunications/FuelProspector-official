import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // Use relative paths for Chrome extension compatibility
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      css: {
        postcss: './postcss.config.js'
      },
      build: {
        // CSP-compliant build for Chrome extension
        target: 'esnext',
        minify: 'esbuild',
        cssCodeSplit: false,
        rollupOptions: {
          output: {
            manualChunks: undefined,
            // Prevent inline scripts in HTML
            inlineDynamicImports: true
          }
        }
      }
    };
});
