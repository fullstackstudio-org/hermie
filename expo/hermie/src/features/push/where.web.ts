/**
 * The browser's half of `where.ts`.
 *
 * There is no EAS project in a browser and no Expo token to mint. What there is
 * is the daemon, which served this very page: ADR-0015 puts Hermie Web next to
 * the gateway and ADR-0017 adds `--push` to it, so `GET /push/vapid-public-key`
 * is a SAME-ORIGIN path and does not need to be configured, guessed, or made
 * reachable separately. That is the whole reason the route belongs to the page's
 * own server rather than to the gateway.
 *
 * It is a relative path on purpose. An absolute one would be a second address to
 * keep in step with the one the browser is already on, and the first time they
 * disagreed the browser would refuse the request anyway.
 */
export const pushProjectId = (): string | null => null

export const pushVapidUrl = (): string | null => '/push/vapid-public-key'
