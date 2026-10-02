import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Expo app is covered by jest-expo (`npm run test:app`); vitest owns the
    // React-free workspace packages, and the native string export, which reads
    // the app's string tables but nothing that needs React.
    include: ['packages/*/src/**/*.test.ts', 'scripts/i18n/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true
  }
})
