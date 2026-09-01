import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // host: true binds 0.0.0.0 so a phone on the same Wi-Fi can open the game.
  server: { host: true },
  preview: { host: true },
  build: { target: 'es2022' },
});
