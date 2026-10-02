/**
 * What the Hermie Web server tells the app about itself.
 *
 * On every other platform there is no such server, so the whole module answers
 * "not applicable" — `web-config.web.ts` is the real one.
 *
 * The SHAPE, and the one function that reads it, live in `web-config.shared.ts`
 * and are re-exported from both halves. That file explains why they may not
 * live here: a relative import written inside `web-config.web.ts` resolves to
 * `web-config.web.ts`, so a `.web` file that re-exports a value from its own
 * twin re-exports it from itself.
 */
import type { HermieWebConfig } from './web-config.shared'

export type { HermieWebBranding, HermieWebConfig, HermieWebFlags, HermieWebService } from './web-config.shared'
export { probeFromWebConfig } from './web-config.shared'

/**
 * The gateway's base URL in a browser: the origin this page was served from,
 * because Hermie Web proxies the gateway onto it. `null` off the web, where the
 * user names an address instead.
 */
export const WEB_GATEWAY_BASE_URL: string | null = null

export async function loadHermieWebConfig(): Promise<HermieWebConfig | null> {
  return null
}
