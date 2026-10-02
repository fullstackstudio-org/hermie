/**
 * When an OPEN chat counts as read.
 *
 * The chat used to be marked read exactly twice — once when it was opened and
 * once when it was left — which is a rule from a phone, where a chat you are
 * reading has hidden the list that would have shown the badge. On the iPad and in
 * a Mac window the list and the chat are side by side, so a reply arriving in the
 * chat the reader is watching lit a badge beside it that nothing would clear
 * until they navigated away and back.
 *
 * The rule the owner asked for has two halves and they are one sentence: a
 * message is read when it arrives IN FRONT of the reader. The reader is in front
 * of it when the chat is open and the transcript is at the bottom; they are not
 * when they have scrolled up into the history, and then the badge is doing its
 * job — it is the same message the jump-to-latest pill is counting. Coming back
 * to the bottom reads everything that arrived while they were away.
 */

/** Where the reader is, for the one decision this module makes. */
export interface ReadPosition {
  /** The transcript is scrolled up: the newest row is not in front of the reader. */
  away: boolean
  /** Whether the chat is on screen at all. */
  open: boolean
}

export function countsAsRead({ away, open }: ReadPosition): boolean {
  return open && !away
}

/**
 * The watermark to write for a chat that has just been read.
 *
 * The later of the two clocks. `now` is this device's and covers a message with
 * no timestamp at all; `lastMessageAt` is the gateway's and covers a gateway
 * whose clock runs ahead of the phone's — which would otherwise stamp a message
 * in the reader's future and leave the badge lit with nothing to show for it.
 */
export function readWatermark(now: number, lastMessageAt: number): number {
  return Math.max(now, lastMessageAt)
}
