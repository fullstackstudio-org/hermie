/**
 * The widget tap, from the snapshot's field to the shell's gateway.
 *
 * Three halves, in two languages. `snapshot.ts` writes `gatewayKey`; the Swift
 * and the Kotlin build `hermie://chat/<bot>?gateway=<key>` out of it; and
 * `deep-link.ts` parses that back before `chat-link.ts` resolves it against the
 * registry. Only the first and the last are TypeScript, so the middle is read
 * out of the two native sources here — the same thing
 * `ios-scene-lifecycle.test.ts` does, and for the same reason: a compiler
 * proves that the Swift builds, not that it builds the right URL.
 *
 * What this pins is the CONTRACT, in the one direction that can silently break:
 * the key the app writes is in the form the parser accepts, and neither side's
 * idea of the parameter's name has drifted from the other's.
 */
import { gatewayKeyOf } from '@hermie/gateway-client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseHermieLink } from '../src/platform/deep-link'

const WIDGETS = join(__dirname, '..', 'modules', 'hermie-widgets')

const swift = readFileSync(join(WIDGETS, 'widget', 'HermieWidgetSnapshot.swift'), 'utf8')
const kotlin = readFileSync(
  join(WIDGETS, 'android', 'src', 'main', 'java', 'nl', 'fullstackstudio', 'hermie', 'widgets', 'HermieWidgetStore.kt'),
  'utf8'
)
const providers = readFileSync(
  join(
    WIDGETS,
    'android',
    'src',
    'main',
    'java',
    'nl',
    'fullstackstudio',
    'hermie',
    'widgets',
    'HermieWidgetProviders.kt'
  ),
  'utf8'
)

/** The pinned vector from `gateway-key.ts`, which both copies prove against. */
const ORIGIN = 'https://gateway.example.com:8443'
const KEY = 'bf796761db84e312'

describe('the key the app writes', () => {
  it('is what the parser on the other side accepts', () => {
    expect(gatewayKeyOf(ORIGIN)).toBe(KEY)
    expect(parseHermieLink(`hermie://chat/researcher?gateway=${KEY}`)).toEqual({
      kind: 'chat',
      bot: 'researcher',
      gatewayKey: KEY
    })
  })

  /**
   * A snapshot written before the field existed, and a widget binary that has
   * never heard of it, both land here. The tap still opens the bot; it simply
   * opens it on whichever gateway is current, exactly as it always did.
   */
  it('leaves the link a plain one when there is no key', () => {
    expect(parseHermieLink('hermie://chat/researcher')).toEqual({
      kind: 'chat',
      bot: 'researcher',
      gatewayKey: ''
    })
  })

  /** An escaped name and a query at once: the path is escaped, the key is not. */
  it('survives a name that had to be escaped', () => {
    expect(parseHermieLink(`hermie://chat/some%20bot?gateway=${KEY}`)).toEqual({
      kind: 'chat',
      bot: 'some bot',
      gatewayKey: KEY
    })
  })
})

describe('the iOS widget', () => {
  it('carries the key off the snapshot rather than off the row', () => {
    expect(swift).toMatch(/let gatewayKey: String\?/)
    expect(swift).toMatch(/func stampingGatewayKey\(\)/)
    // Stamped where the snapshot enters the extension, so every widget gets it.
    expect(swift).toMatch(/return snapshot\.stampingGatewayKey\(\)/)
  })

  it('appends it as the parameter the parser reads', () => {
    expect(swift).toContain('?gateway=\\(key)')
  })

  /** Sixteen lowercase hex digits, or the link goes out without one. */
  it('refuses a key that is not the shape gatewayKeyOf produces', () => {
    expect(swift).toMatch(/value\.count == 16 && value\.allSatisfy/)
  })
})

describe('the Android widget', () => {
  it('reads the key off the snapshot document, not off each row', () => {
    expect(kotlin).toMatch(/val gatewayKey = gatewayKeyOrNull\(document\.optString\("gatewayKey"\)\)/)
  })

  it('refuses a key that is not the shape gatewayKeyOf produces', () => {
    expect(kotlin).toMatch(/it\.length == 16/)
  })

  it('appends it as the parameter the parser reads', () => {
    expect(providers).toContain('"?gateway=$key"')
  })

  /**
   * The intent is built from the BOT, not from its name. That is what makes the
   * key reachable at all — the previous signature took a `String?` and had
   * nowhere to get it from.
   */
  it('builds the intent from the row, so the key is in reach', () => {
    expect(providers).toMatch(/private fun chatIntent\(context: Context, bot: HermieWidgetStore\.Bot\?\)/)
    expect(providers).not.toMatch(/chatIntent\(context, bot\.name\)/)
  })
})
