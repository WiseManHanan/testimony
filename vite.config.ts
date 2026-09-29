import { defineConfig } from 'vite';

export default defineConfig({
  base: '/testimony/',
  server: { port: 5173, open: true },
  build: { target: 'es2022' },
});
