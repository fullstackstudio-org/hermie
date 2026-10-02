/**
 * Settings that need the test framework to already exist.
 *
 * `jest.setup.js` runs in `setupFiles`, which is BEFORE the framework is
 * installed — importing the testing library there pulls in matchers that reach
 * for a global `expect` and every suite fails to load with `expect is not
 * defined`. Anything that touches the library belongs here instead.
 */

const { configure } = require('@testing-library/react-native')

/**
 * How long an async query may wait, raised from the library's default second.
 *
 * Several suites wait for something gated on an `Animated` timing — an overlay
 * panel sliding out, a cron detail arriving after a fetch — and this environment
 * runs those as a train of 16ms JS ticks rather than as a native curve. Measured,
 * they land between 1.0 and 1.7 seconds: not slow, but close enough to the default
 * that a busy machine turns them red. They were seen failing in a full parallel run
 * and passing when run alone, which is the signature of exactly that.
 *
 * Raised once, here, rather than at each `waitFor`: the cause is the environment
 * and not any one assertion. It costs a passing suite nothing — `waitFor` returns
 * as soon as its condition holds — and only changes how long a genuinely failing
 * one takes to say so.
 *
 * Most of that second was never the animation. A wait for something to LEAVE,
 * written as `waitFor(() => expect(query()).toBeNull())`, pretty-prints the whole
 * still-mounted panel into a failure message on every poll, at roughly half a
 * second each. `waitForGone` in `__tests__/support/render.tsx` is the form to use.
 */
configure({ asyncUtilTimeout: 5000 })
