import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library registers its own cleanup only when `afterEach` is a global,
// and the suites import from 'vitest' instead of switching globals on.
afterEach(cleanup)
