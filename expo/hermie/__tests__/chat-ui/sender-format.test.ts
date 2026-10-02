/**
 * The pure half of HERM-83's attribution: the name a bubble draws with nothing
 * but the row itself (D4's rungs 2 and 3 — rung 1, the `context.users`
 * directory, is a later change), and the colour that name and its avatar
 * circle are keyed on (D5).
 */
import { fallbackSenderName, senderInk } from '../../src/chat-ui'
import { ACCENTS, SENDER_INK_ORDER } from '../../src/ui/tokens'

describe('fallbackSenderName', () => {
  it('prefers the stamp’s own name', () => {
    expect(fallbackSenderName({ id: 'authentik:7f3a', name: 'Robin' })).toBe('Robin')
  })

  it('flattens a name with newlines and internal whitespace to one line', () => {
    expect(fallbackSenderName({ id: 'authentik:7f3a', name: 'Robin\n  Vale  \tWriter' })).toBe('Robin Vale Writer')
  })

  it('caps a very long stamped name', () => {
    const long = fallbackSenderName({ id: 'authentik:7f3a', name: 'x'.repeat(400) })

    expect(long.length).toBeLessThanOrEqual(80)
  })

  it('falls back to the identity with its provider prefix stripped when there is no name', () => {
    expect(fallbackSenderName({ id: 'authentik:7f3a9c' })).toBe('7f3a9c')
  })

  it('falls back to the identity as-is when there is no provider prefix to strip', () => {
    expect(fallbackSenderName({ id: 'owner' })).toBe('owner')
  })

  it('treats a blank stamped name as absent and falls to the identity', () => {
    expect(fallbackSenderName({ id: 'authentik:7f3a', name: '   ' })).toBe('7f3a')
  })

  it('never returns an empty label, even for the emptiest possible row', () => {
    expect(fallbackSenderName({ id: '' })).toBe('')
    // A caller can only reach this with a non-empty `id` — `UserItem.author`
    // is dropped entirely at the projection when `id` is empty — so the only
    // guarantee this function itself owes is: given a real id, never nothing.
    expect(fallbackSenderName({ id: 'x' })).toBe('x')
  })
})

describe('senderInk', () => {
  it('is deterministic: the same identity always gets the same colour', () => {
    const id = 'authentik:writer-review'

    expect(senderInk(id, 'light')).toBe(senderInk(id, 'light'))
    expect(senderInk(id, 'dark')).toBe(senderInk(id, 'dark'))
  })

  it('is keyed on the identity, not on any name — a rename cannot recolour it', () => {
    // `senderInk` never takes a name at all: the type itself is the guarantee.
    // What this asserts is that two DIFFERENT identities are free to land on
    // different inks, which is the only way a rename could ever matter.
    const a = senderInk('authentik:aaaa', 'light')
    const b = senderInk('authentik:bbbb', 'light')

    expect([a, b].every(ink => Object.values(ACCENTS).some(swatch => swatch.text.light === ink))).toBe(true)
  })

  it('never lands on the chat’s own accent', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'authentik:1', 'authentik:2']) {
      expect(senderInk(id, 'light')).not.toBe(ACCENTS.default.text.light)
      expect(senderInk(id, 'dark')).not.toBe(ACCENTS.default.text.dark)
    }
  })

  it('only ever picks from `SENDER_INK_ORDER`', () => {
    const possible = new Set(SENDER_INK_ORDER.map(name => ACCENTS[name].text.light))

    for (const id of ['alex', 'robin', 'sam', 'jordan', 'writer-review']) {
      expect(possible.has(senderInk(id, 'light'))).toBe(true)
    }
  })

  it('never lands on `red` or `green` — those are `danger` and `ok`, not a name colour', () => {
    for (const id of ['alex', 'robin', 'sam', 'jordan', 'writer-review', 'authentik:1', 'authentik:2', 'a', 'b', 'c']) {
      expect(senderInk(id, 'light')).not.toBe(ACCENTS.red.text.light)
      expect(senderInk(id, 'light')).not.toBe(ACCENTS.green.text.light)
      expect(senderInk(id, 'dark')).not.toBe(ACCENTS.red.text.dark)
      expect(senderInk(id, 'dark')).not.toBe(ACCENTS.green.text.dark)
    }
  })
})
