/**
 * A browser has no Shortcuts and no Spotlight.
 *
 * A no-op rather than an absent module, for the reason `widgets.web.ts` gives:
 * the runner above is built from the same ports on every platform, and a seam
 * that answers honestly is one branch fewer there than an import that has to be
 * guarded.
 *
 * Android needs no file of its own. It resolves the native seam, finds no
 * `HermieIntents` module — the local module is Apple-only — and answers exactly
 * this. Android's own equivalents, App Actions and `ShortcutManager`, are a
 * different model entirely and a separate piece of work; a half-implemented
 * seam pretending otherwise would be worse than saying so.
 */
import type { IntentQueue } from './platform-contracts'

export type { IntentQueue } from './platform-contracts'

export const intentQueue: IntentQueue = {
  available: false,
  async list() {
    return []
  },
  async complete() {
    return false
  },
  async indexBots() {
    return false
  }
}
