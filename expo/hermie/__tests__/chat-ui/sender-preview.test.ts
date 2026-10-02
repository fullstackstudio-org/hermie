/**
 * HERM-83, Task 5: the chat-list line for a group-chat row somebody else sent.
 *
 * `chatRowPreview` (`@hermie/transcript`) decides WHETHER a row is
 * attributed — its own suite (`packages/transcript/src/preview.test.ts`)
 * covers the D3/D6 gate exhaustively — this is about the one step that
 * belongs to the app: turning a resolved `senderName` into the line a row
 * actually shows, the same way `fromHandle` already becomes `🤖 @writer: …`
 * for an inbound teammate DM.
 */
import { formatChatPreview } from '../../src/chat-ui'

/** FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE (HERM-83 polish): see `format.ts`'s `isolate`. */
const FSI = '\u2068'
const PDI = '\u2069'

describe('formatChatPreview, a group-chat sender leading the line', () => {
  it('leads with the sender’s name, plainly — no bot emoji, that is for a teammate handle', () => {
    expect(formatChatPreview({ text: 'draft is ready', senderName: 'Robin', system: false })).toBe(
      `${FSI}Robin${PDI}: draft is ready`
    )
  })

  it('still prefers the bot-DM shape when a row somehow carried both', () => {
    // Cannot happen from `preview.ts` today — a `user` row and a `bot_dm_in`
    // row are different kinds — but the two prefixes must never compound.
    expect(
      formatChatPreview({ text: 'draft is ready', fromHandle: 'writer', senderName: 'Robin', system: false })
    ).toBe('🤖 @writer: draft is ready')
  })

  it('clips a long sender line exactly like every other preview', () => {
    const long = 'x'.repeat(120)

    expect(formatChatPreview({ text: long, senderName: 'Robin', system: false })).toHaveLength(80)
  })

  it('draws the reader’s own and an unattributed row exactly as before — no prefix at all', () => {
    expect(formatChatPreview({ text: 'ship it', system: false })).toBe('ship it')
  })

  /**
   * HERM-83 polish: a right-to-left name — "שרה" — leading a body that opens
   * with digits or punctuation is exactly the shape that lets the bidi
   * algorithm's own rules reorder the line: without an isolate, the RTL run
   * can swallow the colon and the leading digits into itself and show them in
   * the wrong order. Wrapping the name in FSI…PDI keeps its direction from
   * touching what comes after it.
   */
  it('isolates a right-to-left sender name so it cannot reorder what follows', () => {
    expect(formatChatPreview({ text: '12 new files', senderName: 'שרה', system: false })).toBe(
      `${FSI}שרה${PDI}: 12 new files`
    )
  })
})
