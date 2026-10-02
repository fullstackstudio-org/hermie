/**
 * What is waiting in the share outbox, as something a screen can subscribe to.
 *
 * `ShareDelivery` is the truth and this is its shop window. The delivery flow
 * has no React in it — it runs from an `AppState` listener and from the gateway
 * becoming ready — so it publishes through this store rather than holding a
 * callback into a component that may not be mounted.
 *
 * Nothing here is persisted, and that is the point. The outbox directory on
 * disk is the durable queue; this is a projection of it, rebuilt on every pump.
 * A store that also remembered would be a second answer to "what is waiting",
 * and the two would disagree the first time the app was killed mid-delivery.
 */
import { create } from 'zustand'

import type { PendingShare } from '../features/share/outbox'

export interface ShareState {
  /** Everything read off disk and not yet sent, oldest first. */
  waiting: PendingShare[]
  setWaiting: (waiting: readonly PendingShare[]) => void
  reset: () => void
}

export const useShareStore = create<ShareState>(set => ({
  waiting: [],

  setWaiting(waiting) {
    set({ waiting: [...waiting] })
  },

  /**
   * Called when the gateway connection goes.
   *
   * The entries survive on disk — they belong to the phone, not to a gateway —
   * but a badge pointing at a bot on a roster that has just been emptied is a
   * badge on a row that is not there. The next pump puts them back.
   */
  reset() {
    set({ waiting: [] })
  }
}))

/**
 * How many shares are waiting for one bot.
 *
 * A count rather than a boolean because the row draws a number, and because
 * "two things are waiting" is a different fact from "something is waiting" the
 * moment somebody shares twice while the gateway is down.
 */
export function pendingSharesFor(waiting: readonly PendingShare[], botName: string): number {
  return waiting.filter(share => share.bot === botName).length
}

/**
 * The entries the picker has to ask about.
 *
 * Two shapes, and the second was added by ADR-0026:
 *
 *  - **No bot.** Android's `ACTION_SEND` path: the system's chooser picked
 *    Hermie, not a chat, so nobody has said where this goes.
 *  - **A claim.** An entry a share extension got as far as submitting without
 *    hearing back. It names a bot, and it still needs a person — see
 *    `SHARE_CLAIM_FILE` for why neither sending nor dropping it is safe.
 *
 * Both are "this is waiting on a human", which is what the picker means, and
 * folding them together here rather than at the sheet keeps the sheet
 * presentational.
 */
export function unassignedShares(waiting: readonly PendingShare[]): PendingShare[] {
  return waiting.filter(share => !share.bot || share.claim)
}

/** The badge's number for one row. Selected as a number so a row re-renders once. */
export function usePendingShareCount(botName: string): number {
  return useShareStore(state => pendingSharesFor(state.waiting, botName))
}

/** The oldest share still waiting for a chat, or nothing. One sheet at a time. */
export function useUnassignedShare(): PendingShare | undefined {
  return useShareStore(state => unassignedShares(state.waiting)[0])
}
