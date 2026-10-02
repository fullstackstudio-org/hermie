/**
 * The app's half of ADR-0016: the two stores against the two `ui_meta` keys.
 *
 * `packages/gateway-client/src/ui-meta.test.ts` exercises the protocol against a
 * real fake gateway. This is the adapter above it, and what is worth pinning here
 * is what a projection can get quietly wrong:
 *
 *  - the SHAPE: which store field lands in which key, and that `sidebarCollapsed`
 *    lands in neither, because it is about the window in front of the reader;
 *  - the DIFF: a change anybody makes, through any setter, is noticed — and a
 *    section that goes AWAY (unarchived, colour back to Default) is a change too,
 *    which is the case a diff over the new snapshot alone would miss;
 *  - the LOOP that must not close: applying a gateway's copy into the stores must
 *    not read back as a local change and be sent straight home again.
 */
import { keyValueStore } from '../src/platform/key-value-store'
import { CHAT_LAYOUT_KEY, useChatLayoutStore } from '../src/store/chat-layout'
import { useSettingsStore } from '../src/store/settings'
import { applySnapshot, snapshotFromStores, UiMetaBridge, type HermieAppShape } from '../src/store/ui-meta-bridge'

const settled = () => new Promise(resolve => setTimeout(resolve, 5))

beforeEach(async () => {
  useChatLayoutStore.getState().reset()
  useSettingsStore.getState().reset()
  // The arrangement is persisted per gateway, so one case's dividers are the
  // next one's unless the disk is cleared with the store.
  await keyValueStore.delete(CHAT_LAYOUT_KEY)
  await useChatLayoutStore.getState().load('http://gateway.example')
})

describe('the projection', () => {
  it('puts a bot’s own settings in the bot key and the rest in the app key', () => {
    useChatLayoutStore.getState().addFolder('Finance')
    useChatLayoutStore.getState().setArchived('writer', true)
    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    useSettingsStore.getState().setDefaults({ level: 'verbose' })
    useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: 'graphite' })

    const snapshot = snapshotFromStores()
    const app = snapshot.app as HermieAppShape

    expect(snapshot.bots).toEqual({
      writer: { v: 1, archived: true },
      researcher: { v: 1, colour: 'lime' }
    })
    expect(app.defaults?.level).toBe('verbose')
    expect(app.themeChoice).toEqual({ kind: 'preset', name: 'graphite' })
    // The top level names a folder by id; the folder itself carries the name.
    expect(app.entries?.some(entry => entry.kind === 'folder')).toBe(true)
    expect(app.folders?.some(folder => folder.name === 'Finance')).toBe(true)
  })

  it('leaves the sidebar out of it', () => {
    useChatLayoutStore.getState().setSidebarCollapsed(true)

    // A desktop hiding its list must not collapse a tablet's, and a phone has no
    // sidebar to collapse at all.
    expect(JSON.stringify(snapshotFromStores())).not.toContain('sidebarCollapsed')
  })

  it('reads a gateway’s copy back into both stores', () => {
    applySnapshot({
      app: {
        v: 1,
        entries: [{ kind: 'chat', name: 'writer' }],
        defaults: { level: 'quiet', showBotToBot: false, showThinking: true },
        themeChoice: { kind: 'preset', name: 'lime' },
        themes: [{ id: 't1', name: 'Studio', base: 'lime' }]
      } as HermieAppShape,
      bots: { researcher: { v: 1, archived: true, colour: 'teal' } }
    })

    expect(useChatLayoutStore.getState().entries).toEqual([{ kind: 'chat', name: 'writer' }])
    expect(useChatLayoutStore.getState().archived).toEqual({ researcher: true })
    expect(useChatLayoutStore.getState().accents).toEqual({ researcher: 'teal' })
    expect(useSettingsStore.getState().defaults.level).toBe('quiet')
    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'lime' })
    expect(useSettingsStore.getState().userThemes[0]?.name).toBe('Studio')
  })

  /**
   * The name order travels, because it is a preference and not a device fact.
   *
   * An additive field on an unbumped section version: a reader that meets a `v`
   * it does not know re-seeds the whole section from its own local copy, so
   * bumping would hand an older build the power to delete the arrangement
   * rather than protecting this key from it.
   */
  describe('which of a bot’s names leads', () => {
    it('is projected into the app section', () => {
      useSettingsStore.getState().setBotNameOrder('display')

      expect((snapshotFromStores().app as HermieAppShape).botNameOrder).toBe('display')
    })

    it('comes back out of a gateway’s copy', () => {
      applySnapshot({ app: { v: 1, botNameOrder: 'display' } as HermieAppShape, bots: {} })

      expect(useSettingsStore.getState().botNameOrder).toBe('display')
    })

    it('leaves this reader on their own choice when the section never mentions it', () => {
      // A section written by a build that predates the field says nothing about
      // it, and "absent" must not be read as "they chose the other one".
      useSettingsStore.getState().setBotNameOrder('display')
      applySnapshot({ app: { v: 1 } as HermieAppShape, bots: {} })

      expect(useSettingsStore.getState().botNameOrder).toBe('display')
    })

    it('ignores a value it does not recognise', () => {
      // Set away from the default first, so "kept what this reader chose" and
      // "fell back to the default" are two different answers here.
      useSettingsStore.getState().setBotNameOrder('profile')
      applySnapshot({ app: { v: 1, botNameOrder: 'handle' } as unknown as HermieAppShape, bots: {} })

      expect(useSettingsStore.getState().botNameOrder).toBe('profile')
    })
  })

  /**
   * The name the reader gave a bot, which is theirs and not the profile's.
   *
   * It rides in the app-wide section rather than on the bot's own for the reason
   * it exists at all: no call a client has writes a profile's `display_name`, so
   * the editable name is this reader's and two people on one gateway do not have
   * to agree on it. Additive on an unbumped section version, like the fields
   * around it.
   */
  describe('what this reader calls a bot', () => {
    it('is projected into the app section', () => {
      useChatLayoutStore.getState().setLabel('writer', 'De Schrijver')

      expect((snapshotFromStores().app as HermieAppShape).labels).toEqual({ writer: 'De Schrijver' })
    })

    it('is not also written onto the bot’s own section', () => {
      // A name in two places is two names to keep in step, and the bot's section
      // is shared by everybody on the gateway.
      useChatLayoutStore.getState().setAccent('writer', 'lime')
      useChatLayoutStore.getState().setLabel('writer', 'De Schrijver')

      expect(snapshotFromStores().bots).toEqual({ writer: { v: 1, colour: 'lime' } })
    })

    it('comes back out of a gateway’s copy', () => {
      applySnapshot({ app: { v: 1, labels: { writer: 'De Schrijver' } } as HermieAppShape, bots: {} })

      expect(useChatLayoutStore.getState().labels).toEqual({ writer: 'De Schrijver' })
    })

    it('leaves this reader’s own names alone when the section never mentions them', () => {
      // A section written by a build that predates the field says nothing about
      // names, and "absent" must not be read as "nobody named anything".
      useChatLayoutStore.getState().setLabel('writer', 'De Schrijver')
      applySnapshot({ app: { v: 1 } as HermieAppShape, bots: {} })

      expect(useChatLayoutStore.getState().labels).toEqual({ writer: 'De Schrijver' })
    })

    it('is cleared by an empty map, which is the other answer', () => {
      // Which is why the projection always sends the key: emptying the field on
      // the sheet is how a reader takes a name back, and an omitted key would
      // leave it standing on every other device for ever.
      useChatLayoutStore.getState().setLabel('writer', 'De Schrijver')
      applySnapshot({ app: { v: 1, labels: {} } as HermieAppShape, bots: {} })

      expect(useChatLayoutStore.getState().labels).toEqual({})
    })
  })

  it('does not read an absent arrangement as an empty one', () => {
    // A gateway nobody has written to has no arrangement. Taking that as "no
    // rows anywhere" would empty a list somebody spent an afternoon on.
    useChatLayoutStore.getState().addFolder('Finance')

    applySnapshot({ app: { v: 1 }, bots: {} })

    expect(useChatLayoutStore.getState().entries).toHaveLength(1)
  })

  it('ignores a colour this build does not have', () => {
    applySnapshot({ app: null, bots: { researcher: { v: 1, colour: 'tartan' } } })

    expect(useChatLayoutStore.getState().accents).toEqual({})
  })
})

describe('the bridge', () => {
  /**
   * Whoever the gateway named.
   *
   * Every case here has one, because the app-wide key carries a person's name
   * and a bridge that has not been told one writes no arrangement at all. On a
   * token gateway — which is what this fake is — that name is `owner`.
   */
  const OWNER = 'owner'

  /** A gateway that records what it was asked, and answers an empty roster. */
  function recorder() {
    const calls: { method: string; params?: Record<string, unknown> }[] = []

    return {
      calls,
      request: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params })

        return method === 'profiles.list'
          ? {
              profiles: [
                {
                  name: 'researcher',
                  is_default: true,
                  ui_meta: {
                    'hermes-bots': {},
                    /*
                      A plugin that reads the per-person key. Without this
                      advert the bridge would ALSO write the bare `hermie-app`
                      to keep the registrations where an older notifier is
                      looking, which is a different case with its own cases in
                      `packages/gateway-client/src/ui-meta.test.ts`.
                    */
                    'hermie-plugin': {
                      v: 1,
                      version: '0.2.0',
                      capabilities: ['ui_meta.per_user', 'push.seen.per_chat'],
                      modules: { push: 'on' }
                    }
                  }
                }
              ]
            }
          : { ok: true, applied: { ui_meta: true, ui_meta_revisions: { hermie: 1, 'hermie-app:owner': 1 } } }
      }
    }
  }

  it('sends a section anybody changed, whichever setter did it', async () => {
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)
    const stop = bridge.start()

    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    await settled()

    const write = gateway.calls.find(call => call.method === 'profiles.configure')

    expect(write?.params?.name).toBe('researcher')
    expect(write?.params?.ui_meta).toMatchObject({ hermie: { colour: 'lime' } })
    // Only the key it is changing: `hermes-bots` is not ours to send.
    expect(Object.keys((write?.params?.ui_meta ?? {}) as object)).toEqual(['hermie'])

    stop()
  })

  it('notices a section that went away', async () => {
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)

    useChatLayoutStore.getState().setArchived('writer', true)

    const stop = bridge.start()

    useChatLayoutStore.getState().setArchived('writer', false)
    await settled()

    const write = gateway.calls.find(call => call.method === 'profiles.configure')

    // Removed, not emptied: a bot with nothing to say leaves no key behind.
    expect(write?.params?.ui_meta).toEqual({ hermie: null })

    stop()
  })

  it('seeds a gateway that has no section yet, and then says nothing more', async () => {
    // An absent key is not a decision anybody made. A reader who arranged their
    // list before signing in on a second device would otherwise find both the
    // tablet and the gateway empty, each waiting for the other to go first.
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)
    const stop = bridge.start()

    await bridge.reconcile()
    await settled()

    expect(gateway.calls.filter(call => call.method === 'profiles.configure')).toHaveLength(1)

    // And nothing echoes: what came back in must not read as a local change.
    gateway.calls.length = 0
    await settled()

    expect(gateway.calls).toHaveLength(0)

    stop()
  })

  it('sends one request per profile, not one per section', async () => {
    const gateway = recorder()
    const bridge = new UiMetaBridge({ gateway, debounceMs: 0 })

    bridge.setUser(OWNER)

    await bridge.reconcile()

    const stop = bridge.start()

    // The reconcile above seeded the empty gateway; this case is about what goes
    // out AFTER that.
    gateway.calls.length = 0

    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: 'lime' })
    await settled()

    const writes = gateway.calls.filter(call => call.method === 'profiles.configure')

    // `researcher` is the default profile here, so both sections are its own —
    // and the protocol applies the sections of one request independently.
    expect(writes).toHaveLength(1)
    expect(Object.keys((writes[0]?.params?.ui_meta ?? {}) as object).sort()).toEqual(['hermie', 'hermie-app:owner'])

    stop()
  })
})
