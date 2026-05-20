import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, '.', '');
    const geminiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    const appPin = env.APP_PIN || process.env.APP_PIN || '';

    if (command === 'build') {
      if (!geminiKey) {
        throw new Error('GEMINI_API_KEY is not set. Refusing to build a bundle without it.');
      }
      if (!appPin || !/^\d{4}$/.test(appPin)) {
        throw new Error('APP_PIN must be set to a 4-digit string. Refusing to build.');
      }
    }

    return {
      // Use relative paths for Chrome extension compatibility
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(geminiKey),
        'process.env.GEMINI_API_KEY': JSON.stringify(geminiKey),
        'process.env.APP_PIN': JSON.stringify(appPin),
        'process.env.MAPS_API': JSON.stringify(env.MAPS_API || process.env.MAPS_API || '')
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
