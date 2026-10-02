/**
 * The two addresses a registration needs, and which build has which.
 *
 * Native mints an Expo token against `extra.eas.projectId`; a browser mints a
 * `PushSubscription` against a VAPID public key it fetches from the daemon. They
 * are exclusive — a build has exactly one of them — so both are read here and
 * the platform ignores the one that is not its own.
 */
import { easProjectId } from './platform'

export const pushProjectId = (): string | null => easProjectId()

/**
 * Where the daemon publishes its VAPID public key. Native has none.
 *
 * The browser build's answer is in `where.web.ts`: the page and the key come
 * from the same origin, because Hermie Web serves both.
 */
export const pushVapidUrl = (): string | null => null
