import { defineConfig } from 'vitest/config'

/**
 * Unit and component tests of the web client: jsdom, Testing Library. Kept apart
 * from the root `vitest.config.ts` (React-free packages, Node) so that `npm test`
 * at the repository root never needs a DOM.
 */
export default defineConfig({
  define: {
    // Fixed stand-ins for what `vite.config.ts` injects into a build.
    __HERMIE_VERSION__: JSON.stringify('0.0.0-test'),
    __HERMIE_COMMIT__: JSON.stringify('0123456789abcdef0123456789abcdef01234567')
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts']
  }
})
