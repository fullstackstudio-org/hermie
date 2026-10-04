import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Expo app is covered by jest-expo (`npm run test:app`); vitest owns the
    // React-free workspace packages, and the native string export, which reads
    // the app's string tables but nothing that needs React.
    // `scripts/web` is the web client's bundle gate (`npm run client:check-bundle`);
    // the client's own suites run under jsdom in `native/web` (`npm run client:test`).
    // `scripts/release` pins the version everywhere `scripts/set-version.mjs` writes it.
    include: [
      'packages/*/src/**/*.test.ts',
      'scripts/i18n/**/*.test.ts',
      'scripts/web/**/*.test.ts',
      'scripts/release/**/*.test.ts'
    ],
    environment: 'node',
    passWithNoTests: true
  }
})
