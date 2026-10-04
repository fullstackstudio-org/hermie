import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * The shell's own two pages (`connect.html`, `offline.html`) — vanilla TS, no
 * React, no React Native Web. This is a separate Vite project from
 * `expo/hermie` on purpose: the app the shell loads is the browser client a
 * gateway already serves (the removed `packages/hermie-web` served the Expo
 * export; see docs/desktop.md), unmodified; nothing here is bundled into it,
 * and nothing from it is bundled into this.
 *
 * `TAURI_DEV_HOST` lets `tauri dev` reach the Vite server from something
 * other than the machine it runs on (a mobile target, unused here, but the
 * variable is the one the Tauri docs standardise on).
 */
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  root: 'src',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        connect: resolve(__dirname, 'src/connect.html'),
        offline: resolve(__dirname, 'src/offline.html')
      }
    }
  },
  // Tauri expects a fixed, predictable dev server port.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: {
      // Rust file changes are the Cargo/Tauri watcher's job, not Vite's.
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_']
})
