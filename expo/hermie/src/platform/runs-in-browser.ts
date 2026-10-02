/**
 * Is this the browser build?
 *
 * `Platform.OS` already answers it, and this constant exists so the answer has
 * one name and one comment rather than a literal `'web'` scattered across the
 * features that branch on it. It is the sibling of `RUNS_ON_MAC`, and unlike
 * that one it needs no native module: react-native-web sets `Platform.OS` to
 * `'web'` itself.
 *
 * What the browser build is, in one line: the app served by Hermie Web
 * (`packages/hermie-web`), which proxies the gateway onto the same origin, so
 * the gateway is always `window.location.origin` and the session is the
 * gateway's own cookie.
 *
 * A constant, not a hook: it cannot change while the page lives, and the first
 * render already needs it.
 */
import { Platform } from 'react-native'

export const RUNS_IN_BROWSER = Platform.OS === 'web'
