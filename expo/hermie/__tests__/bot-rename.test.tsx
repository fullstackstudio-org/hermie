/**
 * Naming a bot: the field, the separate rename, and the keys a rename moves.
 *
 * Four things are worth asserting and they are four different failures:
 *
 *  - **The field is the DISPLAY name.** The owner renamed a bot expecting its
 *    label to change and watched its handle move instead, because that is what
 *    `PATCH /api/profiles/{name}` does to every profile but `default`. The field
 *    is Hermie's own name for the bot now, and core's rename route is not what
 *    it writes.
 *  - **Save is what commits it, and typing a name enables Save.** The field used
 *    to write itself into the arrangement on every keystroke, which left the
 *    sheet's only button greyed out while a reader typed a new name into it —
 *    the complaint this suite grew from was "I change the name and I cannot
 *    press Save".
 *  - **Renaming the profile is still reachable, and it is its own act.** Behind
 *    its own disclosure, with its own button, and not offered at all for a
 *    profile that cannot be renamed or a connection that cannot do it.
 *  - **The stores are rekeyed.** A bot's name is this app's primary key. If the
 *    gateway renames a profile and nothing local moves, the next roster read
 *    drops the colour, the folder, the note, the name the reader gave it, the
 *    watermark and the cached transcript — silently, because a missing key reads
 *    as a new bot.
 *  - **A refusal stays a refusal.** 400 and 404 are the two the route answers,
 *    and neither may be reported as a success or leave the stores half moved.
 */
import { createChatState } from '@hermie/transcript'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import type { GatewayHttp } from '@hermie/gateway-client'
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'

import { BotProfileSheet } from '../src/features/bot-profile'
import { DISPLAY_NAME_ROUTE, renameBot, renameProfile, ProfileRenameError } from '../src/features/bot-rename'
import type { ChatGateway } from '../src/gateway/link'
import { type ChatCache, chatCacheFor } from '../src/platform/chat-cache'
import { useBotsStore, type Bot } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { useDeviceContextStore } from '../src/store/device-context'
import { usePluginStore } from '../src/store/plugin'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

/*
  The real cache opens SQLite (or IndexedDB) on first use, which a test process
  has neither of. The in-memory implementation is the same contract, which is
  the whole reason `chat-cache-core.ts` exists.
*/
jest.mock('../src/platform/chat-cache', () => {
  const core = jest.requireActual('../src/platform/chat-cache-core')
  const caches = new Map<string, unknown>()

  // One per gateway, memoised exactly as the real module memoises: `renameBot`
  // asks for the cache by id, and a second instance would answer an empty one.
  return {
    ...core,
    chatCacheFor: (gatewayId: string) => {
      if (!caches.has(gatewayId)) {
        caches.set(gatewayId, new core.MemoryChatCache())
      }

      return caches.get(gatewayId)
    }
  }
})

/** The gateway the rename is happening on. One is enough to key a cache by. */
const GATEWAY = 'gaaaaaaaaaaaaaaaa'

const cache = (): ChatCache => chatCacheFor(GATEWAY)

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Reads things so you do not have to.',
  model: 'claude-sonnet-4-6-20251001',
  provider: 'anthropic',
  isDefault: false,
  hasAvatar: false,
  canonical: { id: 'sess-7', resolvedId: 'sess-7', preview: '', lastActive: 0, messageCount: 0 },
  uiMetaRevision: 3
}

const DEFAULT_BOT: Bot = { ...BOT, name: 'default', displayName: 'default', isDefault: true }

/** A gateway that answers the two socket calls the sheet may make. */
function fakeGateway(): ChatGateway {
  return {
    request: jest.fn(async () => ({ ok: true, applied: { description: true } })),
    on: () => () => undefined,
    onAny: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined,
    fetchMessages: async () => null
  } as unknown as ChatGateway
}

/** The REST half, recorded. `patch` is the only verb this feature uses. */
function fakeHttp(answer: unknown | (() => never)) {
  const calls: { path: string; body: unknown }[] = []

  const http = {
    patch: jest.fn(async (path: string, body: unknown) => {
      calls.push({ path, body })

      if (typeof answer === 'function') {
        return (answer as () => never)()
      }

      return answer
    })
  } as unknown as GatewayHttp

  return { http, calls }
}

function sheet(bot: Bot, http: GatewayHttp | null, onSaved?: () => void) {
  return renderScreen(
    <BotProfileSheet
      bot={bot}
      gateway={fakeGateway()}
      gatewayVersion="0.21.3"
      onClose={() => undefined}
      visible
      {...(http ? { http } : {})}
      {...(onSaved ? { onSaved } : {})}
    />
  )
}

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useDeviceContextStore.getState().reset()
  usePluginStore.getState().reset()
  useSettingsStore.getState().reset()
})

/**
 * What this gateway's plugin says it can do.
 *
 * `null` leaves the store unread, which is the state before a roster has
 * arrived: the sheet must say nothing about where a name goes until it knows.
 */
function pluginSays(capabilities: string[] | null): void {
  if (capabilities === null) {
    return
  }

  usePluginStore.getState().apply({ version: '0.3.0', capabilities, modules: {}, limits: {}, updatedAt: 1 })
}

// -- which name the field is editing -----------------------------------------

/** Open the profile-rename disclosure and type a new handle into it. */
function typeNewProfileName(next: string): void {
  fireEvent.press(screen.getByTestId('bot-profile-name-rename'))
  fireEvent.changeText(screen.getByTestId('bot-profile-name-rename-field'), next)
}

/** Is the sheet's one button pressable right now? */
const saveDisabled = (): boolean => screen.getByTestId('bot-profile-save').props.accessibilityState.disabled === true

describe('the name field', () => {
  /**
   * The complaint, as one assertion.
   *
   * Typing a name is a change to the only thing on this sheet a reader came to
   * change, so the button that saves has to notice. It did not: the field wrote
   * straight into the arrangement and `changesFor` only ever looked at the
   * description and the picture, so Save stayed disabled for ever and nothing on
   * the screen said the name had been kept anyway.
   */
  it('enables Save when a name is typed, and stores it when Save is pressed', async () => {
    const { http, calls } = fakeHttp({ ok: true })

    sheet(BOT, http)

    expect(saveDisabled()).toBe(true)

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'De Onderzoeker')

    expect(saveDisabled()).toBe(false)
    // Not yet: the field holds a draft, and Save is what commits it.
    expect(useChatLayoutStore.getState().labels.researcher).toBeUndefined()

    await act(async () => {
      fireEvent.press(screen.getByTestId('bot-profile-save'))
    })

    expect(useChatLayoutStore.getState().labels.researcher).toBe('De Onderzoeker')
    // Core's rename route is not what a display name goes through.
    expect(calls).toHaveLength(0)
  })

  /** A name that is already the stored one is not a change, so Save stays shut. */
  it('does not count retyping the same name as a change', () => {
    useChatLayoutStore.getState().setLabel('researcher', 'De Onderzoeker')
    sheet(BOT, fakeHttp({ ok: true }).http)

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), '  De Onderzoeker  ')

    expect(saveDisabled()).toBe(true)
  })

  /**
   * The name is the app's own, so it is saved on a gateway that is not
   * answering. Everything else on this sheet is a write to the profile on the
   * gateway's disk and stays unavailable.
   */
  it('saves a name with no connection at all', async () => {
    renderScreen(<BotProfileSheet bot={BOT} gateway={null} onClose={() => undefined} visible />)

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'De Onderzoeker')

    expect(saveDisabled()).toBe(false)

    await act(async () => {
      fireEvent.press(screen.getByTestId('bot-profile-save'))
    })

    expect(useChatLayoutStore.getState().labels.researcher).toBe('De Onderzoeker')
  })

  /** Emptying it is how a reader goes back to the name the gateway reports. */
  it('clears the name rather than storing an empty one', async () => {
    useChatLayoutStore.getState().setLabel('researcher', 'De Onderzoeker')
    sheet(BOT, fakeHttp({ ok: true }).http)

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), '   ')

    expect(saveDisabled()).toBe(false)

    await act(async () => {
      fireEvent.press(screen.getByTestId('bot-profile-save'))
    })

    expect(useChatLayoutStore.getState().labels.researcher).toBeUndefined()
  })

  it('is a field on the default profile too, and offers no rename there', () => {
    sheet(DEFAULT_BOT, fakeHttp({ ok: true }).http)

    expect(screen.getByTestId('bot-profile-name')).toBeTruthy()
    expect(screen.queryByTestId('bot-profile-name-rename')).toBeNull()
    expect(screen.getByTestId('bot-profile-name-default')).toBeTruthy()
  })

  /** Without a REST half nothing can rename, so the act is simply not offered. */
  it('still takes a display name when the connection has no REST surface', () => {
    sheet(BOT, null)

    expect(screen.getByTestId('bot-profile-name')).toBeTruthy()
    expect(screen.queryByTestId('bot-profile-name-rename')).toBeNull()
  })

  it('says what renaming the profile costs, once the disclosure is open', () => {
    sheet(BOT, fakeHttp({ ok: true }).http)

    expect(screen.queryByTestId('bot-profile-name-warning')).toBeNull()

    fireEvent.press(screen.getByTestId('bot-profile-name-rename'))

    expect(screen.getByTestId('bot-profile-name-warning')).toHaveTextContent(
      'Renaming changes the profile name other tools use'
    )
  })

  /**
   * HERM-110's "hide profile name" only touches the two-line display; it must
   * not touch the one place on this sheet where the profile name is the whole
   * point — the fact row and the rename field both address the PROFILE, not
   * whichever name the header happens to be leading with.
   */
  it('still shows and renames the profile name while Hide profile name is on', () => {
    expect(useSettingsStore.getState().hideHandleWhenNamed).toBe(true)

    sheet({ ...BOT, displayName: 'De Onderzoeker' }, fakeHttp({ ok: true }).http)

    // The fact row: always the handle, whatever the header leads with.
    expect(screen.getByText('Profile name')).toBeTruthy()
    expect(screen.getByText('researcher')).toBeTruthy()

    // The rename disclosure's own field starts from the handle too.
    fireEvent.press(screen.getByTestId('bot-profile-name-rename'))
    expect(screen.getByTestId('bot-profile-name-rename-field').props.value).toBe('researcher')
  })
})

// -- which gateway the name is saved on --------------------------------------

describe('the display name and the plugin route', () => {
  /** The route the plugin's `profiles.display_name` capability points at. */
  it('sends the name to the plugin route and stores it locally too, with the capability', async () => {
    const { http, calls } = fakeHttp({ name: 'researcher', display_name: 'De Onderzoeker' })

    pluginSays([PLUGIN_CAPABILITIES.profilesDisplayName])
    sheet(BOT, http)

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'De Onderzoeker')

    await act(async () => {
      fireEvent.press(screen.getByTestId('bot-profile-save'))
    })

    expect(calls).toEqual([{ path: `${DISPLAY_NAME_ROUTE}/researcher`, body: { display_name: 'De Onderzoeker' } }])
    // The next roster refresh reads the same value back, but the list redraws now.
    expect(useChatLayoutStore.getState().labels.researcher).toBe('De Onderzoeker')
  })

  /** 403: the reason lands beside the field it is about, and nothing moves. */
  it('shows a 403 beside the field and stores nothing', async () => {
    const { GatewayError } = jest.requireActual('@hermie/gateway-client')
    const { http } = fakeHttp(() => {
      throw new GatewayError('protocol', 'PATCH failed with HTTP 403.', { status: 403 })
    })

    pluginSays([PLUGIN_CAPABILITIES.profilesDisplayName])
    sheet(BOT, http)

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'De Onderzoeker')

    await act(async () => {
      fireEvent.press(screen.getByTestId('bot-profile-save'))
    })

    expect(screen.getByText('This gateway account may not change profile names.')).toBeTruthy()
    expect(useChatLayoutStore.getState().labels.researcher).toBeUndefined()
  })

  /** No capability: the app-only line shows up front, and the name stays local. */
  it('shows the app-only line and keeps the name local, without the capability', async () => {
    const { http, calls } = fakeHttp({ ok: true })

    pluginSays([PLUGIN_CAPABILITIES.memoryBrowse])
    sheet(BOT, http)

    expect(screen.getByTestId('bot-profile-name-app-only')).toHaveTextContent(
      'Stored in Hermie only; the gateway plugin is too old to save it on the gateway.'
    )

    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'De Onderzoeker')

    await act(async () => {
      fireEvent.press(screen.getByTestId('bot-profile-save'))
    })

    expect(calls).toHaveLength(0)
    expect(useChatLayoutStore.getState().labels.researcher).toBe('De Onderzoeker')
  })

  /** No roster read yet: neither line is drawn, because nothing is known. */
  it('says nothing about where the name goes before a roster has been read', () => {
    sheet(BOT, fakeHttp({ ok: true }).http)

    expect(screen.queryByTestId('bot-profile-name-app-only')).toBeNull()
  })
})

// -- the call ----------------------------------------------------------------

describe('renaming the profile', () => {
  it('sends new_name to PATCH /api/profiles/{name} and nothing else', async () => {
    const { http, calls } = fakeHttp({ ok: true, name: 'analyst', path: '/root/.hermes/profiles/analyst' })
    const onSaved = jest.fn()

    sheet(BOT, http, onSaved)
    typeNewProfileName('analyst')
    fireEvent.press(screen.getByTestId('bot-profile-name-rename-save'))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ path: '/api/profiles/researcher', body: { new_name: 'analyst' } })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  /** Save is for the description and the photo, and a rename is neither. */
  it('leaves Save disabled, because nothing it sends has changed', () => {
    sheet(BOT, fakeHttp({ ok: true }).http)
    typeNewProfileName('analyst')

    expect(screen.getByTestId('bot-profile-save').props.accessibilityState.disabled).toBe(true)
  })

  it('shows a 400 beside the rename field instead of closing', async () => {
    const { GatewayError } = jest.requireActual('@hermie/gateway-client')
    const { http } = fakeHttp(() => {
      throw new GatewayError('protocol', 'PATCH failed with HTTP 400.', { status: 400 })
    })

    sheet(BOT, http)
    typeNewProfileName('analyst')
    fireEvent.press(screen.getByTestId('bot-profile-name-rename-save'))

    await waitFor(() => expect(screen.getByText('The gateway would not take that name.')).toBeTruthy())
  })

  it('shows a 404 as a missing profile rather than as a missing endpoint', async () => {
    const { GatewayError } = jest.requireActual('@hermie/gateway-client')
    const { http } = fakeHttp(() => {
      throw new GatewayError('protocol', 'The gateway has no PATCH /api/profiles/researcher endpoint.', {
        status: 404
      })
    })

    sheet(BOT, http)
    typeNewProfileName('analyst')
    fireEvent.press(screen.getByTestId('bot-profile-name-rename-save'))

    await waitFor(() => expect(screen.getByText('The gateway has no profile called researcher.')).toBeTruthy())
  })

  /** `rename_profile` refuses it before the setter sees it, so the app does too. */
  it('refuses to clear the default profile without asking the gateway', async () => {
    const { http, calls } = fakeHttp({ ok: true })

    await expect(renameProfile(http, 'default', '   ')).rejects.toBeInstanceOf(ProfileRenameError)
    expect(calls).toHaveLength(0)
  })

  it('reads a display-name answer as a label and NOT as a rename', async () => {
    const { http } = fakeHttp({ ok: true, name: 'default', display_name: 'Jurist', path: '/root/.hermes' })
    const answer = await renameProfile(http, 'default', 'Jurist')

    expect(answer).toEqual({ name: 'default', displayName: 'Jurist', path: '/root/.hermes', renamed: false })
  })

  it('reads an answer without a display name as a real rename', async () => {
    const { http } = fakeHttp({ ok: true, name: 'analyst', path: '/root/.hermes/profiles/analyst' })
    const answer = await renameProfile(http, 'researcher', 'analyst')

    expect(answer.renamed).toBe(true)
    expect(answer.displayName).toBeNull()
  })
})

// -- the keys ----------------------------------------------------------------

describe('renameBot', () => {
  async function seed(): Promise<void> {
    useBotsStore.getState().setBots([BOT])
    useBotsStore.getState().markSeen('researcher', 400)
    useChatsStore.getState().hydrate('researcher', createChatState('researcher', 'sess-7', 'sess-7'))
    useChatsStore.getState().bindRuntime('researcher', 'runtime-1')
    useChatsStore.getState().markLive('researcher')
    useChatLayoutStore.getState().reconcile(['researcher'])
    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    useChatLayoutStore.getState().setLabel('researcher', 'De Onderzoeker')
    useChatLayoutStore.getState().setArchived('researcher', true)
    useChatLayoutStore.getState().setMute('researcher', 0)
    await cache().write({
      bot: 'researcher',
      itemsJson: '[]',
      lastRowId: 9,
      lastSeq: 4,
      epoch: 'e1',
      updatedAt: 1
    })
  }

  it('moves every key the app holds a bot under', async () => {
    await seed()

    const result = await act(async () => renameBot('researcher', 'analyst', GATEWAY))

    expect(result).toEqual({ ok: true, failed: [] })

    const bots = useBotsStore.getState()
    const chats = useChatsStore.getState()
    const layout = useChatLayoutStore.getState()

    expect(bots.byName.analyst?.name).toBe('analyst')
    expect(bots.byName.researcher).toBeUndefined()
    expect(bots.lastSeen.analyst).toBe(400)

    expect(chats.chats.analyst?.botName).toBe('analyst')
    expect(chats.chats.researcher).toBeUndefined()
    expect(chats.botForRuntime('runtime-1')).toBe('analyst')
    expect(chats.live.analyst).toBe(true)

    expect(layout.entries).toContainEqual({ kind: 'chat', name: 'analyst' })
    expect(layout.entries).not.toContainEqual({ kind: 'chat', name: 'researcher' })
    expect(layout.accents.analyst).toBe('lime')
    expect(layout.labels.analyst).toBe('De Onderzoeker')
    expect(layout.labels.researcher).toBeUndefined()
    expect(layout.accents.researcher).toBeUndefined()
    expect(layout.archived.analyst).toBe(true)
    expect(layout.mutes.analyst).toBe(0)

    expect((await cache().read('analyst'))?.lastRowId).toBe(9)
    expect(await cache().read('researcher')).toBeNull()
  })

  it('moves a bot inside a folder with the folder', async () => {
    await seed()
    useChatLayoutStore.getState().addFolderAround('researcher', 'Work')

    await act(async () => renameBot('researcher', 'analyst', GATEWAY))

    expect(useChatLayoutStore.getState().folders[0]?.bots).toEqual(['analyst'])
  })

  /** The `default` profile keeps its id, so there is nothing to move. */
  it('does nothing when the name did not actually change', async () => {
    await seed()

    expect(await renameBot('researcher', 'researcher', GATEWAY)).toEqual({ ok: true, failed: [] })
    expect(useChatsStore.getState().chats.researcher).toBeTruthy()
  })
})
