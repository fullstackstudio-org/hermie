import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// What the page loads with the chat screen's and the Settings pages' chunks, here from the start: a test calls the
// chat controller's and the passkey model's methods as those screens do, and they run at once, as they do once that
// chunk is there (`core/on-demand.ts`).
import './core/chat-controller-on-demand'
import './core/passkey/model-on-demand'

// Testing Library registers its own cleanup only when `afterEach` is a global,
// and the suites import from 'vitest' instead of switching globals on.
afterEach(cleanup)
