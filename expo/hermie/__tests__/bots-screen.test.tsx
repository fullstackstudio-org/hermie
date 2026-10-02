/**
 * The chat list as a screen: what a row shows, and what a tap does.
 *
 * The roster, the running set and the open requests come from three different
 * stores on purpose (see `BotsScreen`), so the assertions here are mostly about
 * a row correctly reading all three at once.
 */
import { act, fireEvent, screen, within } from '@testing-library/react-native'

import { BotsScreen } from '../src/features/bots'
import { strings } from '../src/i18n/strings'
import { ICON_SIZE } from '../src/ui/Icon'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useSettingsStore } from '../src/store/settings'
import { useChatsStore } from '../src/store/chats'
import { useShareStore } from '../src/store/share'
import { renderScreen } from './support/render'

// Two modules, because the gateway card reaches for the provider directly
// rather than through the barrel — it needs the sign-in action, not just the
// status.
const gateway = { status: 'ready', config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' } }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...gateway,
    adoptTokens: jest.fn(),
    signOut: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {}
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

const NOW = Math.floor(Date.now() / 1000)

const bot = (patch: Partial<Bot> & { name: string }): Bot => ({
  displayName: patch.name,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  ...patch
})

const ROSTER: Bot[] = [
  bot({
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Finds things out.',
    canonical: {
      id: 'stored-researcher',
      resolvedId: 'stored-researcher',
      preview: 'Message from 🤖 Writer (@writer): Draft is ready, I pushed it.',
      lastActive: NOW - 30,
      messageCount: 12
    }
  }),
  bot({
    name: 'writer',
    displayName: 'Writer',
    description: 'Writes things down.',
    canonical: {
      id: 'stored-writer',
      resolvedId: 'stored-writer',
      preview: 'Which tone should I use?',
      lastActive: NOW - 7200,
      messageCount: 4
    }
  })
]

function seedRoster() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots(ROSTER)
}

/**
 * A hold that ends where it started, which is what opens the fallback sheet.
 *
 * The sheet is deferred until the press is over, because the same hold is also
 * how a row is picked up: on a platform with no native menu there is nothing to
 * cancel a menu that is already on screen, so the list holds it back instead and
 * opens it only if the hold never became a drag. Two events, therefore, where
 * one used to do — and a test that fires only the long press is testing the
 * moment the reader is still deciding.
 */
function hold(testID: string) {
  fireEvent(screen.getByTestId(testID), 'longPress')
  fireEvent(screen.getByTestId(testID), 'pressOut')
}

/** An open approval in Writer's chat — the "needs your input" badge's source. */
function seedOpenApproval() {
  useChatsStore.getState().ensure('writer', { storedSessionId: 'stored-writer', resolvedSessionId: 'stored-writer' })
  useChatsStore.getState().dispatchServerRequest('writer', {
    id: 'srq-1',
    method: 'approval',
    params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-1' }
  })
}

describe('BotsScreen', () => {
  beforeEach(seedRoster)

  it('renders a row per bot with its preview and stamp', () => {
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
    // The row leads with the profile name. `Researcher` is this handle in
    // different case, which is one name and not two, so there is no second line.
    expect(screen.getByText('researcher')).toBeTruthy()
    expect(screen.queryByTestId('bot-secondary-name-researcher')).toBeNull()
    expect(screen.getByText('Which tone should I use?')).toBeTruthy()
  })

  it('folds a "Message from" preview down to the sender handle', () => {
    renderScreen(<BotsScreen />)

    expect(screen.getByText('🤖 @writer: Draft is ready, I pushed it.')).toBeTruthy()
  })

  it('falls back to the description when the chat has no preview yet', () => {
    useBotsStore.getState().setBots([bot({ name: 'builder', displayName: 'Builder', description: 'Builds things.' })])
    renderScreen(<BotsScreen />)

    expect(screen.getByText('Builds things.')).toBeTruthy()
  })

  it('marks a bot unread until its chat has been looked at', () => {
    // The dot itself is hidden from assistive tech on purpose — the row's own
    // accessibility label carries "New" — so the query has to opt in.
    const dots = () => screen.queryAllByTestId('bot-unread', { includeHiddenElements: true })

    renderScreen(<BotsScreen />)
    expect(dots()).toHaveLength(2)

    screen.unmount()
    useBotsStore.getState().markSeen('writer', NOW)
    renderScreen(<BotsScreen />)

    expect(dots()).toHaveLength(1)
  })

  it('names the presence and unread state on the row itself, for a screen reader', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    // The bead never carries the state on colour alone; this label is what a
    // screen reader gets instead of it.
    expect(screen.getByLabelText('researcher, Working…, New')).toBeTruthy()
    expect(screen.getByLabelText('writer, Online, New')).toBeTruthy()
  })

  it('shows the working state for a bot the gateway reports as busy', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-presence-researcher')).toBeTruthy()
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).toContain('Working…')
    expect(screen.getByTestId('bot-row-writer').props.accessibilityLabel).not.toContain('Working…')
  })

  it('outranks working with needs-input for the chat waiting on an answer', () => {
    useBotsStore.getState().setRunning(['writer'])
    seedOpenApproval()
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-row-writer').props.accessibilityLabel).toContain('Needs input')
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).not.toContain('Needs input')
  })

  it('filters by name and by description', () => {
    renderScreen(<BotsScreen />)

    fireEvent.changeText(screen.getByTestId('bots-search'), 'writ')
    expect(screen.queryByTestId('bot-row-researcher')).toBeNull()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()

    fireEvent.changeText(screen.getByTestId('bots-search'), 'finds things')
    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.queryByTestId('bot-row-writer')).toBeNull()

    fireEvent.changeText(screen.getByTestId('bots-search'), 'nobody')
    expect(screen.getByTestId('bots-empty')).toBeTruthy()
  })

  it('opens the tapped bot', () => {
    const onOpenBot = jest.fn()

    renderScreen(<BotsScreen onOpenBot={onOpenBot} />)
    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(onOpenBot).toHaveBeenCalledWith(expect.objectContaining({ name: 'researcher' }))
  })

  it('offers the other sections only where a shell asked for the tabs', () => {
    const onOpenSection = jest.fn()

    renderScreen(<BotsScreen />)
    expect(screen.queryByTestId('tab-settings')).toBeNull()

    screen.unmount()
    renderScreen(<BotsScreen onOpenSection={onOpenSection} />)
    fireEvent.press(screen.getByTestId('tab-cron'))

    expect(onOpenSection).toHaveBeenCalledWith('cron')
  })

  it('explains an empty roster', () => {
    useBotsStore.getState().setBots([])
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bots-empty')).toBeTruthy()
  })
})

/**
 * A bot with two genuinely different names gets two lines, in the order this
 * reader chose; one whose display name is only its handle in different case
 * gets one. See `store/bot-names.ts`.
 */
describe('the two names a bot has', () => {
  const NAMED: Bot[] = [
    bot({
      name: 'lance-vance',
      displayName: 'Netwerkbeheerder',
      description: 'Keeps the network up.',
      canonical: { id: 's', resolvedId: 's', preview: 'All quiet.', lastActive: 1_700_000_100, messageCount: 1 }
    })
  ]

  beforeEach(() => {
    // Hide profile name off: these cases are about the ORDER setting, and
    // HERM-110's override would otherwise always print the display name,
    // masking which order is in effect.
    useSettingsStore.setState({ botNameOrder: 'profile', hideHandleWhenNamed: false })
    useBotsStore.getState().setBots(NAMED)
  })

  afterEach(() => useSettingsStore.setState({ botNameOrder: 'profile', hideHandleWhenNamed: false }))

  it('leads with the profile name by default, and says the display name under it', () => {
    renderScreen(<BotsScreen />)

    expect(screen.getByText('lance-vance')).toBeTruthy()
    expect(screen.getByTestId('bot-secondary-name-lance-vance').props.children).toBe('Netwerkbeheerder')
  })

  it('swaps the two lines when the reader asks for the display name first', () => {
    useSettingsStore.setState({ botNameOrder: 'display' })
    renderScreen(<BotsScreen />)

    expect(screen.getByText('Netwerkbeheerder')).toBeTruthy()
    expect(screen.getByTestId('bot-secondary-name-lance-vance').props.children).toBe('lance-vance')
  })

  it('announces both names to a screen reader, whichever order they are in', () => {
    renderScreen(<BotsScreen />)

    expect(screen.getByLabelText(/^lance-vance, Netwerkbeheerder,/)).toBeTruthy()
  })
})

/**
 * Arranging the list, with nothing to switch on first.
 *
 * There was an Edit mode: a word in the header that revealed a grip on every row
 * and a bar under the list, pressed again to put them away. The owner rejected
 * it — _"The Edit button is not needed. When I hold a chat I want to be able to
 * move it right away."_ — so what it used to switch on is either always on (the
 * reorder actions), reached by holding the row (the drag), or in the header's
 * `…` (New folder).
 */
describe('arranging the list', () => {
  beforeEach(seedRoster)

  /** The header's `…`, opened. Everything that is not a row lives behind it. */
  function openHeadMenu() {
    fireEvent.press(screen.getByTestId('bots-head-overflow'))
  }

  /** New folder, from that menu, which is the only way to make one from nowhere. */
  function addFolder() {
    openHeadMenu()
    fireEvent.press(screen.getByTestId('bots-head-overflow-new-folder'))

    return (useChatLayoutStore.getState().entries.find(entry => entry.kind === 'folder') as { id: string }).id
  }

  it('has no mode to enter, and nothing left that only a mode could reveal', () => {
    renderScreen(<BotsScreen />)

    expect(screen.queryByTestId('bots-edit')).toBeNull()
    expect(screen.queryByTestId('edit-bar')).toBeNull()
    expect(screen.queryByTestId('bot-drag-handle-writer')).toBeNull()
  })

  /**
   * The column is gone, and the arrows it replaced are still gone.
   *
   * It used to carry a pair of ↑/↓ buttons inside a 26pt handle, which put three
   * tap targets in the space of one; the grip that replaced them has now gone
   * with the mode that revealed it. Both are worth pinning: a row has no
   * furniture on it at all.
   */
  it('draws no grip and no arrows, on any row', () => {
    renderScreen(<BotsScreen />)

    for (const name of ['researcher', 'writer']) {
      expect(screen.queryByTestId(`bot-drag-handle-${name}`)).toBeNull()
      expect(screen.queryByTestId(`bot-move-up-${name}`)).toBeNull()
      expect(screen.queryByTestId(`bot-move-down-${name}`)).toBeNull()
    }
  })

  /**
   * Reordering a step at a time, for the readers a drag does not serve.
   *
   * VoiceOver's rotor and a keyboard both read `accessibilityActions`, and they
   * used to be offered only in edit mode — so a screen-reader reader had to find
   * and turn on a mode before the list would let them arrange it. They are on
   * every row that has a position now, at all times.
   */
  it('reorders a bot from the row’s accessibility actions', () => {
    renderScreen(<BotsScreen />)

    expect(useChatLayoutStore.getState().entries.map(entry => entry.kind === 'chat' && entry.name)).toEqual([
      'researcher',
      'writer'
    ])

    const row = screen.getByTestId('bot-row-writer')

    expect(row.props.accessibilityActions).toEqual([
      { name: 'moveUp', label: strings.layout.moveUp },
      { name: 'moveDown', label: strings.layout.moveDown }
    ])

    fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'moveUp' } })

    expect(useChatLayoutStore.getState().entries.map(entry => entry.kind === 'chat' && entry.name)).toEqual([
      'writer',
      'researcher'
    ])

    fireEvent(screen.getByTestId('bot-row-writer'), 'accessibilityAction', {
      nativeEvent: { actionName: 'moveDown' }
    })

    expect(useChatLayoutStore.getState().entries.map(entry => entry.kind === 'chat' && entry.name)).toEqual([
      'researcher',
      'writer'
    ])
  })

  /** An archived chat is in the drawer and has no position, so it offers none. */
  it('offers no reorder actions on an archived row', () => {
    renderScreen(<BotsScreen />)

    hold('bot-row-writer')
    fireEvent.press(screen.getByTestId('row-menu-archive'))
    fireEvent.press(screen.getByTestId('archived-row'))

    expect(screen.getByTestId('bot-row-writer').props.accessibilityActions).toBeUndefined()
  })

  it('reorders a folder from its accessibility actions', () => {
    renderScreen(<BotsScreen />)

    const id = addFolder()

    expect(useChatLayoutStore.getState().entries.at(-1)).toEqual({ kind: 'folder', id })

    fireEvent(screen.getByTestId(`folder-${id}`), 'accessibilityAction', {
      nativeEvent: { actionName: 'moveUp' }
    })

    expect(useChatLayoutStore.getState().entries.at(-1)).not.toEqual({ kind: 'folder', id })
    expect(useChatLayoutStore.getState().entries[1]).toEqual({ kind: 'folder', id })
  })

  it('adds a folder from the header menu and keeps it on screen while it is empty', () => {
    renderScreen(<BotsScreen />)

    const id = addFolder()

    // Named by typing, not by editing a seeded word: a pre-filled name means
    // the first thing typed lands after it.
    expect(useChatLayoutStore.getState().entries).toContainEqual({ kind: 'folder', id })
    // Empty, but visible: there has to be something to move a row into.
    expect(screen.getByTestId(`folder-${id}`)).toBeTruthy()
  })

  it('opens the new folder focused, empty, with a placeholder that is not a name', () => {
    // The owner's device still carries a section called "New sectionFinance",
    // from a build that seeded the field with "New section". The placeholder has
    // to say what the field is FOR without ever becoming its value.
    renderScreen(<BotsScreen />)

    const field = screen.getByTestId(`folder-name-${addFolder()}`)

    expect(field.props.value).toBe('')
    expect(field.props.placeholder).toBe('Folder name')
    expect(field.props.autoFocus).toBe(true)
  })

  /**
   * The field belongs to ONE folder, and closes itself.
   *
   * Edit mode turned every folder's name into a field at once and left them that
   * way until the reader pressed Done. A name is typed once, so the field is
   * open for the folder being named and for as long as the caret is in it.
   */
  it('takes the field away again when the name is finished', () => {
    renderScreen(<BotsScreen />)

    const id = addFolder()

    fireEvent.changeText(screen.getByTestId(`folder-name-${id}`), 'Finance')
    fireEvent(screen.getByTestId(`folder-name-${id}`), 'submitEditing')

    expect(screen.queryByTestId(`folder-name-${id}`)).toBeNull()
    expect(screen.getByTestId(`folder-${id}`)).toHaveTextContent('Finance')
  })

  /**
   * The caret leaving is an ending too, not only Return.
   *
   * A field opened by Rename would otherwise stay open until something else
   * re-rendered the row, which is a mode by another name — one folder wide.
   */
  it('takes the field away when the caret leaves it', () => {
    renderScreen(<BotsScreen />)

    const id = addFolder()

    fireEvent(screen.getByTestId(`folder-name-${id}`), 'blur')

    expect(screen.queryByTestId(`folder-name-${id}`)).toBeNull()
  })

  /** A folder made from a row's own menu opens in its field, like any other. */
  it('opens the field for a folder made around a chat', () => {
    renderScreen(<BotsScreen />)

    hold('bot-row-writer')
    fireEvent.press(screen.getByTestId('row-menu-newFolder'))

    const id = (useChatLayoutStore.getState().entries.find(entry => entry.kind === 'folder') as { id: string }).id

    expect(screen.getByTestId(`folder-name-${id}`).props.autoFocus).toBe(true)
  })

  /** A folder made by mistake goes away where it was made. */
  it('offers Remove while the folder is being named', () => {
    renderScreen(<BotsScreen />)

    const id = addFolder()

    fireEvent.press(screen.getByTestId(`folder-remove-${id}`))

    expect(useChatLayoutStore.getState().entries.some(entry => entry.kind === 'folder')).toBe(false)
  })
})

/**
 * Two headings that met with nothing between them.
 *
 * An empty named section used to be dropped from the list. That cost two things:
 * a section whose last chat moved out vanished, so there was nothing left to
 * move a chat back INTO; and two headings then landed back to back with only a
 * heading's own padding between them and read as one run-on line — which is how
 * "NEW SECTIONFINANCE" got onto the screen and then into the stored arrangement
 * as a single name.
 */
describe('a folder with nothing in it', () => {
  beforeEach(seedRoster)

  /** Two named sections, the second holding every bot, the first holding none. */
  function twoFolders() {
    // The roster has to be folded in first: `moveToFolder` moves a bot that is
    // already in the arrangement, and the screen's own reconcile has not run at
    // this point.
    useChatLayoutStore.getState().reconcile(['researcher', 'writer'])

    const empty = useChatLayoutStore.getState().addFolder('Work')
    const full = useChatLayoutStore.getState().addFolder('Finance')

    useChatLayoutStore.getState().moveToFolder('researcher', full)
    useChatLayoutStore.getState().moveToFolder('writer', full)

    return { empty, full }
  }

  it('keeps its header and gets a row of its own', () => {
    const { empty } = twoFolders()

    renderScreen(<BotsScreen />)

    expect(screen.getByTestId(`folder-${empty}`)).toBeTruthy()
    expect(screen.getByTestId(`folder-empty-${empty}`)).toBeTruthy()
  })

  it('puts a row between two headers rather than letting them meet', () => {
    const { empty, full } = twoFolders()

    renderScreen(<BotsScreen />)

    /*
      The three rows this is about, named exactly.
      
      A prefix match would also pick up what a folder is DRAWN with — its plate,
      its mark, its chevron, the plate under each of its chats — none of which is
      a row, and one of which wraps the header rather than following it, so a
      prefix would report a header twice and fail for a reason that is not this
      test's.
    */
    const ids = screen
      .getAllByTestId(new RegExp(`^(folder-${empty}|folder-empty-${empty}|folder-${full})$`))
      .map(node => node.props.testID as string)

    // The empty folder, its own row, then the next folder. Never two headers
    // adjacent.
    expect(ids).toEqual([`folder-${empty}`, `folder-empty-${empty}`, `folder-${full}`])
  })

  it('stays out of the way of a search, which narrows the list on purpose', () => {
    const { empty } = twoFolders()

    renderScreen(<BotsScreen />)
    fireEvent.changeText(screen.getByTestId('bots-search'), 'writer')

    expect(screen.queryByTestId(`folder-${empty}`)).toBeNull()
    expect(screen.queryByTestId(`folder-empty-${empty}`)).toBeNull()
  })
})

describe('the row context menu', () => {
  beforeEach(seedRoster)

  it('opens on a long press and archives the bot out of the list', () => {
    renderScreen(<BotsScreen />)

    hold('bot-row-writer')
    fireEvent.press(screen.getByTestId('row-menu-archive'))

    expect(useChatLayoutStore.getState().archived).toEqual({ writer: true })
    // Out of the list proper, and folded under the archived disclosure instead.
    expect(screen.queryByTestId('bot-row-writer')).toBeNull()
    expect(screen.getByTestId('archived-row')).toHaveTextContent(/Archived \(1\)/)
  })

  it('keeps an archived bot out of the list and the unread count', () => {
    renderScreen(<BotsScreen />)

    hold('bot-row-writer')
    fireEvent.press(screen.getByTestId('row-menu-archive'))

    expect(screen.queryByTestId('bot-row-writer')).toBeNull()

    // It is still reachable, just not counted: the disclosure opens it.
    fireEvent.press(screen.getByTestId('archived-row'))
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer').props.accessibilityLabel).not.toContain('New')
  })

  it('sets a per-chat colour, and Default stores nothing', () => {
    renderScreen(<BotsScreen />)

    hold('bot-row-writer')
    fireEvent.press(screen.getByTestId('swatch-writer-teal'))
    expect(useChatLayoutStore.getState().accents).toEqual({ writer: 'teal' })

    // A selection closes the menu, the way the platform's own does — so a second
    // colour is a second hold rather than a second tap in a sheet that stayed
    // open behind the first.
    hold('bot-row-writer')
    fireEvent.press(screen.getByTestId('swatch-writer-default'))
    expect(useChatLayoutStore.getState().accents).toEqual({})
  })

  it('moves a bot into a folder', () => {
    useChatLayoutStore.getState().reconcile(['researcher', 'writer'])
    const id = useChatLayoutStore.getState().addFolder('Finance')

    renderScreen(<BotsScreen />)
    hold('bot-row-researcher')
    fireEvent.press(screen.getByTestId('row-menu-folder'))
    fireEvent.press(screen.getByTestId(`row-menu-folder-${id}`))

    // Inside the folder, and out of the top level: a bot is in exactly one
    // place, which is the invariant a move has to respect.
    expect(useChatLayoutStore.getState().folders[0]?.bots).toEqual(['researcher'])
    expect(useChatLayoutStore.getState().entries).not.toContainEqual({ kind: 'chat', name: 'researcher' })
  })

  /*
    The drift this sheet was rebuilt to close.

    `row-menu-items.ts` has said from the start that the native menu and this
    sheet are two drawings of ONE list; only the native side was ever moved onto
    it. What a reader on a build without the platform menu could do to the ORDER
    of their list was: move a chat to the top group. Everything below is in the
    native menu and was not in this one.
  */
  it('offers everything the platform menu offers, and moves a row with it', () => {
    useChatLayoutStore.getState().reconcile(['researcher', 'writer'])

    renderScreen(<BotsScreen />)
    hold('bot-row-writer')

    for (const id of ['row-menu-open', 'row-menu-markRead', 'row-menu-newFolder', 'row-menu-archive']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }

    fireEvent.press(screen.getByTestId('row-menu-move--1'))

    expect(useChatLayoutStore.getState().entries).toEqual([
      { kind: 'chat', name: 'writer' },
      { kind: 'chat', name: 'researcher' }
    ])
  })

  it('moves a row down as well as up', () => {
    useChatLayoutStore.getState().reconcile(['researcher', 'writer'])

    renderScreen(<BotsScreen />)
    hold('bot-row-researcher')
    fireEvent.press(screen.getByTestId('row-menu-move-1'))

    expect(useChatLayoutStore.getState().entries).toEqual([
      { kind: 'chat', name: 'writer' },
      { kind: 'chat', name: 'researcher' }
    ])
  })

  it('opens the chat from the menu, which is what its first line says', () => {
    renderScreen(<BotsScreen />)
    hold('bot-row-writer')

    expect(screen.getByTestId('row-menu-open')).toBeTruthy()
  })
})

/**
 * The mark that says a chat is quiet on purpose.
 *
 * Reported by the owner about the old one: "small and not clear". It was a
 * 13pt rounded-top box in `textFaint`, tucked beside the stamp — the wrong
 * size, the wrong ink and, mattering most, the wrong PLACE. Mute is a state of
 * the row, so it belongs against the row's name rather than in the corner where
 * a mark reads as something about the time.
 */
describe('the muted marker', () => {
  beforeEach(seedRoster)

  const renderRows = () => renderScreen(<BotsScreen />)

  it('appears only while the chat is muted', () => {
    renderRows()
    expect(screen.queryByTestId('bot-muted-researcher', { includeHiddenElements: true })).toBeNull()

    act(() => {
      useChatLayoutStore.getState().setMute('researcher', Math.floor(Date.now() / 1000) + 3600)
    })

    expect(screen.getByTestId('bot-muted-researcher', { includeHiddenElements: true })).toBeTruthy()

    act(() => {
      useChatLayoutStore.getState().setMute('researcher', null)
    })

    expect(screen.queryByTestId('bot-muted-researcher', { includeHiddenElements: true })).toBeNull()
  })

  it('draws the bell glyph at the row-mark size, not the metadata marker size', () => {
    act(() => {
      useChatLayoutStore.getState().setMute('researcher', Math.floor(Date.now() / 1000) + 3600)
    })

    const view = renderRows()

    // The NAME of the glyph, because the whole complaint was that the old one
    // did not read as a bell: a size change alone would have left the box.
    expect(view.UNSAFE_getByProps({ name: 'bellMuted' })).toBeTruthy()

    const mark = screen.getByTestId('bot-muted-researcher', { includeHiddenElements: true })

    expect(mark.props.height).toBe(ICON_SIZE.listMark)
    expect(mark.props.width).toBe(ICON_SIZE.listMark)
  })

  it('still says it in words, for a reader who cannot see the glyph', () => {
    act(() => {
      useChatLayoutStore.getState().setMute('researcher', Math.floor(Date.now() / 1000) + 3600)
    })

    renderRows()

    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).toContain(strings.layout.mutedRow)
  })
})

/**
 * Where a row's marks are, which is what the owner rejected twice.
 *
 * The bell moved to the name line in R22 and the rest did not follow, so a
 * muted, pinned chat drew one mark against its name and another in a column
 * beside the unread pill — two thirds of a row lower, and nowhere near the time
 * either of them was supposed to sit beside. The verdict: _"All icons must be to
 * the LEFT of the time, on the row of the big name."_
 *
 * So there is ONE run, and these are its three properties: everything is in it,
 * it is on the name line, and it comes before the time.
 */
describe('the row’s status marks', () => {
  beforeEach(seedRoster)

  const HIDDEN = { includeHiddenElements: true } as const

  /**
   * Every named thing inside one row, in the order it is drawn.
   *
   * Reading positions rather than boxes, because "left of the time" is a
   * statement about ORDER on a line and this environment lays nothing out —
   * every measurement in it is zero. The row is drawn as name line (name, marks,
   * time), then the second name, then the preview, then the unread pill, so the
   * order of those names is enough to place any mark among them.
   */
  function drawnOrder(name: string): string[] {
    const ids: string[] = []
    const walk = (node: { props?: { testID?: string }; children?: unknown[] }) => {
      // Once each: a component and the view it renders both carry the name, and
      // this is a question about order rather than about depth.
      if (typeof node.props?.testID === 'string' && !ids.includes(node.props.testID)) {
        ids.push(node.props.testID)
      }

      for (const child of node.children ?? []) {
        if (typeof child !== 'string') {
          walk(child as { props?: { testID?: string }; children?: unknown[] })
        }
      }
    }

    walk(screen.getByTestId(`bot-row-${name}`, HIDDEN))

    return ids
  }

  function mute(name: string) {
    act(() => {
      useChatLayoutStore.getState().setMute(name, Math.floor(Date.now() / 1000) + 3600)
    })
  }

  function pin(name: string) {
    act(() => {
      useChatLayoutStore.getState().togglePinned(name)
    })
  }

  function shareTo(name: string) {
    act(() => {
      useShareStore.getState().setWaiting([
        {
          id: 'share-1',
          bot: name,
          note: 'Read this',
          createdAt: 0,
          items: [{ kind: 'text', text: 'Read this' }]
        }
      ])
    })
  }

  afterEach(() => {
    act(() => {
      useShareStore.getState().reset()
    })
  })

  it('puts every mark in one run, in one order', () => {
    renderScreen(<BotsScreen />)

    mute('researcher')
    pin('researcher')
    shareTo('researcher')

    const run = screen.getByTestId('bot-marks-researcher', HIDDEN)

    // All three of them, in the order the row lists them, and nothing else. The
    // order is fixed rather than dependent on what is on, so a chat that gains a
    // pin does not shuffle the mark that was already there.
    expect(run.children.map(child => (typeof child === 'string' ? child : child.props.testID))).toEqual([
      'bot-muted-researcher',
      'bot-pinned-researcher',
      'bot-share-pending-researcher'
    ])
  })

  it('draws the run on the name line, immediately before the time', () => {
    renderScreen(<BotsScreen />)

    mute('researcher')
    pin('researcher')

    const order = drawnOrder('researcher')
    const marks = order.indexOf('bot-marks-researcher')
    const time = order.indexOf('bot-time-researcher')

    expect(marks).toBeGreaterThan(-1)
    expect(time).toBeGreaterThan(marks)

    // And nothing of the row's OTHER lines in between, which is what says the
    // run is on the name line rather than under it: the owner's report was that
    // the bell sat "between the name and the display name".
    for (const elsewhere of ['bot-secondary-name-researcher', 'bot-preview-researcher', 'bot-unread']) {
      expect(order.slice(marks, time)).not.toContain(elsewhere)
    }

    // The time is on the FIRST line, so everything below it follows both.
    expect(order.indexOf('bot-preview-researcher')).toBeGreaterThan(time)
  })

  /**
   * The one order the owner's report pins down: the big name first, the run of
   * marks second, the time last. Not merely "marks before time" (the test
   * above) — the bell used to sit BETWEEN the name and the display name, so a
   * regression that moved the run ahead of the name itself would pass every
   * other assertion here while reintroducing exactly that bug.
   */
  it('draws the name line in one fixed order: name, then icons, then time', () => {
    renderScreen(<BotsScreen />)

    mute('researcher')
    pin('researcher')

    const order = drawnOrder('researcher')
    const name = order.indexOf('bot-name-researcher')
    const marks = order.indexOf('bot-marks-researcher')
    const time = order.indexOf('bot-time-researcher')

    expect(name).toBeGreaterThan(-1)
    expect(marks).toBeGreaterThan(name)
    expect(time).toBeGreaterThan(marks)
  })

  it('draws every mark at the row-mark size', () => {
    renderScreen(<BotsScreen />)

    mute('researcher')
    pin('researcher')

    for (const id of ['bot-muted-researcher', 'bot-pinned-researcher']) {
      const mark = screen.getByTestId(id, HIDDEN)

      expect(mark.props.height).toBe(ICON_SIZE.listMark)
      expect(mark.props.width).toBe(ICON_SIZE.listMark)
    }
  })

  /**
   * The trailing column carries the unread pill and nothing else.
   *
   * That column is centred on a 72pt row, so anything in it is drawn opposite
   * the middle of the preview — which is where the pin and the pending share
   * used to be. A count of what ARRIVED belongs there; a mark that describes the
   * row does not.
   */
  it('leaves nothing after the preview but the unread badge', () => {
    renderScreen(<BotsScreen />)

    mute('researcher')
    pin('researcher')
    shareTo('researcher')

    const order = drawnOrder('researcher')

    expect(order.slice(order.indexOf('bot-preview-researcher') + 1)).toEqual(['bot-unread'])
  })

  /** No marks, no run: an empty box would still take its gap beside the time. */
  it('draws no run at all for a row with nothing to say', () => {
    renderScreen(<BotsScreen />)

    expect(screen.queryByTestId('bot-marks-writer', HIDDEN)).toBeNull()
  })
})

describe('the unread badge', () => {
  beforeEach(() => {
    seedRoster()
    // Writer is caught up, so exactly one badge is on screen to assert on.
    useBotsStore.getState().markSeen('writer', NOW)
  })

  /**
   * Two replies and one inbound DM landing after the watermark.
   *
   * The DM is in there so the badge has to say which of the three it counts: the
   * owner's rule is that bot-to-bot traffic never bumps a count, so the answer
   * is two.
   */
  function seedUnread(sinceSeconds: number) {
    const chats = useChatsStore.getState()

    chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
    chats.update('researcher', state => ({
      ...state,
      items: {
        a1: {
          id: 'a1',
          kind: 'assistant',
          interim: false,
          origin: 'live',
          seq: 1000,
          streaming: false,
          text: 'One.',
          ts: sinceSeconds + 1,
          version: 0
        },
        a2: {
          id: 'a2',
          kind: 'assistant',
          interim: false,
          origin: 'live',
          seq: 2000,
          streaming: false,
          text: 'Two.',
          ts: sinceSeconds + 2,
          version: 0
        },
        d1: {
          id: 'd1',
          kind: 'bot_dm_in',
          origin: 'live',
          senderName: 'Writer',
          seq: 3000,
          text: 'Ready.',
          ts: sinceSeconds + 3,
          version: 0
        },
        // Before the watermark: already read.
        a0: {
          id: 'a0',
          kind: 'assistant',
          interim: false,
          origin: 'live',
          seq: 500,
          streaming: false,
          text: 'Old.',
          ts: sinceSeconds - 10,
          version: 0
        }
      },
      order: ['a0', 'a1', 'a2', 'd1']
    }))
  }

  it('counts messages since the watermark once the chat is loaded', () => {
    useBotsStore.getState().markSeen('researcher', NOW - 60)
    seedUnread(NOW - 60)

    renderScreen(<BotsScreen />)

    // Two, not three: `d1` is a teammate's DM, and bot-to-bot traffic is not
    // this reader's mail. Hidden from the screen reader on purpose — the row's
    // own label already says "2 unread messages", and a bare "2" after it would
    // read twice.
    expect(screen.getByTestId('bot-unread', { includeHiddenElements: true })).toHaveTextContent('2')
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).toContain('2 unread messages')
  })

  it('puts no number on the badge when the only new rows are bot-to-bot', () => {
    useBotsStore.getState().markSeen('researcher', NOW - 60)
    seedUnread(NOW - 60)

    // Take the two replies away and leave the DM where it is: the row now has a
    // new row on it by every measure except the one that decides a count.
    useChatsStore.getState().update('researcher', state => ({ ...state, order: ['a0', 'd1'] }))

    renderScreen(<BotsScreen />)

    /*
      The COUNT is what this rule owns. The plain dot beside it is the roster's
      `last_active` — the gateway says a chat moved and says nothing about what
      moved in it — so a client cannot attribute that to a DM and this test does
      not pretend it can. What it pins is that no number is claimed, and that the
      row does not tell a screen reader there are messages waiting.
    */
    const badge = screen.getByTestId('bot-unread', { includeHiddenElements: true })

    expect(within(badge).queryByText(/\d/u)).toBeNull()
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).not.toMatch(/unread message/u)
  })

  it('caps the number rather than widening the badge', () => {
    useBotsStore.getState().markSeen('researcher', NOW - 60)

    const items: Record<string, unknown> = {}
    const order: string[] = []

    for (let index = 0; index < 120; index += 1) {
      const id = `a${index}`

      items[id] = {
        id,
        kind: 'assistant',
        interim: false,
        origin: 'live',
        seq: index * 10,
        streaming: false,
        text: `Line ${index}`,
        ts: NOW - 59 + index,
        version: 0
      }
      order.push(id)
    }

    useChatsStore
      .getState()
      .ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
    useChatsStore.getState().update('researcher', state => ({ ...state, items: items as never, order }))

    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-unread', { includeHiddenElements: true })).toHaveTextContent('99+')
  })

  it('falls back to a dot for a chat this app has never read', () => {
    renderScreen(<BotsScreen />)

    // The roster says researcher moved since the watermark, but nothing is
    // loaded, so there is nothing honest to count.
    expect(screen.getByTestId('bot-unread', { includeHiddenElements: true })).toBeTruthy()
    expect(screen.queryByText('3')).toBeNull()
  })
})

/**
 * One component, both layouts.
 *
 * The wide sidebar used to end in a gateway card carrying the host and the
 * connection state. It is gone: it spent a permanent row saying "Connected",
 * which is what it says every second of every day, and it said it in different
 * words from the phone's own line. What is left is one line under the title
 * that draws nothing at all while the connection is healthy.
 */
describe('the connection state on the two layouts', () => {
  beforeEach(seedRoster)

  afterEach(() => {
    gateway.status = 'ready'
  })

  it.each(['screen', 'sidebar'] as const)('says nothing at all on %s while the gateway is ready', variant => {
    renderScreen(<BotsScreen onOpenSection={jest.fn()} variant={variant} />)

    expect(screen.queryByTestId('connection-line')).toBeNull()
    // The tab strip is still there; it is only the gateway card that went.
    expect(screen.getByTestId('tab-settings')).toBeTruthy()
  })

  it.each(['screen', 'sidebar'] as const)('shows the same status line on %s once it needs attention', variant => {
    gateway.status = 'reconnecting'
    renderScreen(<BotsScreen onOpenSection={jest.fn()} variant={variant} />)

    expect(screen.getByTestId('connection-line')).toHaveTextContent(/Reconnecting/)
  })

  it('has no gateway card left on either layout', () => {
    for (const variant of ['screen', 'sidebar'] as const) {
      const view = renderScreen(<BotsScreen onOpenSection={jest.fn()} variant={variant} />)

      expect(screen.queryByTestId('gateway-card')).toBeNull()
      view.unmount()
    }
  })

  it.each(['screen', 'sidebar'] as const)('says Signed out on %s, and offers the way back', variant => {
    gateway.status = 'needs_signin'
    renderScreen(<BotsScreen onOpenSection={jest.fn()} variant={variant} />)

    expect(screen.getByTestId('connection-line')).toHaveTextContent('Signed out')
    // Tappable, which the other states are not: it is the one a reader can act on.
    expect(screen.getByTestId('connection-sign-in')).toBeTruthy()
  })
})

/**
 * The initial, when there is no picture.
 *
 * Most bots on a real gateway have none: uploading one is opt-in, and
 * `profiles.list` answers `has_avatar: false` for the rest, so the app never
 * asks for an asset and the row draws the generated initial instead. That path
 * went unlooked-at for two passes because the fake gateway answered
 * `has_avatar: true` for EVERY profile and served a flat 1x1 PNG — so every row
 * in every screenshot was a coloured disc and the fallback was unreachable. The
 * fake gateway now leaves Writer without one; this pins the rendering.
 */
describe('a bot with no picture', () => {
  beforeEach(seedRoster)

  it('draws the initial rather than an empty circle', () => {
    renderScreen(<BotsScreen />)

    // Both roster bots are `hasAvatar: false`, so nothing was ever fetched.
    expect(useBotsStore.getState().avatars).toEqual({})
    // The avatar is decorative, so its initial is hidden from the a11y tree —
    // the row's own label is what a screen reader reads.
    expect(screen.getByText('R', { includeHiddenElements: true })).toBeTruthy()
    expect(screen.getByText('W', { includeHiddenElements: true })).toBeTruthy()
  })

  it('draws the picture instead once one has been fetched', () => {
    useBotsStore.getState().setAvatar('writer', 1, 'data:image/png;base64,iVBORw0KGgo=')

    renderScreen(<BotsScreen />)

    expect(screen.getByText('R', { includeHiddenElements: true })).toBeTruthy()
    // Writer's initial has given way to the image.
    expect(screen.queryByText('W', { includeHiddenElements: true })).toBeNull()
  })
})
