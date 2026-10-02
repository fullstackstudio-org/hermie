/**
 * Per-chat notification types: narrower than mute, and on top of it.
 *
 * Mute is "say nothing at all about this chat". These are "say this but not
 * that" — a bot whose scheduled runs are noise but whose failures are not, which
 * is exactly why `cron`, `cron_done` and `cron_failed` are three switches and
 * not one. The plugin already honours per-type settings globally; what is new
 * is a per-chat override beside the registrations in the same `push` section,
 * which the notifier reads at `hermie-app.push.perBot.<bot>.<type>`.
 *
 * Three properties, and each one is a different way to get this wrong:
 *
 *  1. **An override is PARTIAL.** A type a chat says nothing about follows the
 *     global switch as the global switch moves. Writing all five the moment one
 *     is touched would freeze the others at whatever they were that day.
 *  2. **An empty override leaves nothing behind**, so "back to the default" is
 *     indistinguishable from "never touched" — in the store and on the wire.
 *  3. **The section version is NOT bumped.** `v` is checked per ROW and an
 *     unreadable row is dropped, so a bump would not protect this key from an
 *     older notifier: it would unregister the device and make the phone go
 *     quiet. A notifier that does not know the field keeps sending what the
 *     global types say, which is what it did before the field existed.
 */
import { act } from '@testing-library/react-native'

import {
  effectivePushTypes,
  noPushTypes,
  PUSH_SECTION_VERSION,
  pushPerBotOf,
  pushSectionFor
} from '@hermie/gateway-client/push'
import { usePushStore } from '../src/store/push'
import { applySnapshot, snapshotFromStores } from '../src/store/ui-meta-bridge'

beforeEach(() => {
  act(() => {
    usePushStore.getState().reset()
  })
})

describe('the rule itself', () => {
  it('folds an override into the global types and leaves the rest alone', () => {
    const global = { ...noPushTypes(), turn_done: true, turn_failed: true, cron: true, cron_failed: true }

    expect(effectivePushTypes(global, { cron: false })).toEqual({
      ...global,
      cron: false
    })
  })

  it('follows the global switch for a type the chat says nothing about', () => {
    const before = effectivePushTypes({ ...noPushTypes(), turn_done: false }, { cron: false })
    const after = effectivePushTypes({ ...noPushTypes(), turn_done: true }, { cron: false })

    expect(before.turn_done).toBe(false)
    // The global moved and the chat had no opinion about this type, so it moved
    // with it. That is the whole point of the bag being partial.
    expect(after.turn_done).toBe(true)
  })

  it('is the identity when a chat has no overrides at all', () => {
    const global = { ...noPushTypes(), request: true }

    expect(effectivePushTypes(global, undefined)).toEqual(global)
  })
})

describe('the store', () => {
  it('records one type without inventing an opinion about the others', () => {
    act(() => {
      usePushStore.getState().setBotType('researcher', 'cron', false)
    })

    expect(usePushStore.getState().perBot.researcher).toEqual({ cron: false })
  })

  it('removes an override rather than writing false for it', () => {
    act(() => {
      usePushStore.getState().setBotType('researcher', 'cron', false)
      usePushStore.getState().setBotType('researcher', 'turn_done', true)
      usePushStore.getState().setBotType('researcher', 'cron', null)
    })

    expect(usePushStore.getState().perBot.researcher).toEqual({ turn_done: true })
  })

  it('leaves nothing behind when the last override goes', () => {
    act(() => {
      usePushStore.getState().setBotType('researcher', 'cron', false)
      usePushStore.getState().setBotType('researcher', 'cron', null)
    })

    expect(usePushStore.getState().perBot.researcher).toBeUndefined()
  })

  it('puts a whole chat back on the global types', () => {
    act(() => {
      usePushStore.getState().setBotType('researcher', 'cron', false)
      usePushStore.getState().setBotType('researcher', 'turn_failed', false)
      usePushStore.getState().resetBotTypes('researcher')
    })

    expect(usePushStore.getState().perBot.researcher).toBeUndefined()
  })
})

describe('the section it writes', () => {
  it('carries the overrides beside the registrations, not inside a row', () => {
    const section = pushSectionFor({
      others: {},
      own: null,
      seen: {},
      now: 1000,
      perBot: { researcher: { cron: false } }
    })

    expect(section?.perBot).toEqual({ researcher: { cron: false } })
    // Beside, not inside: a device's row is about a device and this is about
    // the reader.
    expect(section?.registrations).toEqual({})
  })

  it('omits the key entirely when nothing is overridden', () => {
    const section = pushSectionFor({
      others: { i1: { v: 1 } },
      own: null,
      seen: {},
      now: 1000,
      perBot: { researcher: {} }
    })

    expect(section?.perBot).toBeUndefined()
  })

  it('does not bump the section version, because an unreadable row is a dropped row', () => {
    // If this ever has to change, the phone goes quiet on every gateway running
    // an older notifier. See the header of this file.
    expect(PUSH_SECTION_VERSION).toBe(1)
  })

  it('reads a section back defensively, dropping what is not a type', () => {
    expect(
      pushPerBotOf({
        push: { perBot: { researcher: { cron: false, nonsense: 'yes' }, '': { cron: false }, other: 7 } }
      })
    ).toEqual({ researcher: { cron: false } })
  })

  it('survives a round trip through the app-wide section', () => {
    act(() => {
      usePushStore.getState().setBotType('researcher', 'cron', false)
    })

    const app = snapshotFromStores().app as { push?: { perBot?: Record<string, unknown> } }

    expect(app.push?.perBot).toEqual({ researcher: { cron: false } })

    act(() => {
      usePushStore.getState().reset()
      applySnapshot({ app, bots: {} })
    })

    expect(usePushStore.getState().perBot.researcher).toEqual({ cron: false })
  })
})
