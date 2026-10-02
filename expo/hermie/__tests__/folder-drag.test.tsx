/**
 * Dragging a FOLDER, which was the one row the gesture could not pick up.
 *
 * The hook was keyed by bot name end to end — `arm('finance-bot')`,
 * `rowHandlers('finance-bot')`, and a lifted key rebuilt as `` `bot:${name}` ``
 * in two places. `folder-rows.ts` has always described the list in row KEYS, so
 * the one kind of row whose key the hook did not speak was the one kind it
 * could not drag: the lookup for a folder's own anchor could only ever miss,
 * which put the lift's origin at anchor 0 and moved every neighbour the wrong
 * way.
 *
 * Two halves are tested here and they fail differently:
 *
 *  - the arithmetic (`isSameRowPlace`, `committedRowIndex`, `topLevelIndexOf`),
 *    which is where a folder dropped inside another folder has to become a
 *    top-level position rather than a nested one — folders do not nest;
 *  - the screen, where the folder row has to carry the same grip, the same pan
 *    handlers and the same lift as a chat row, and a drop has to reach
 *    `dropFolder` rather than `dropBot`.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { BotsScreen } from '../src/features/bots/BotsScreen'
import {
  botRowKey,
  committedRowIndex,
  dragAnchors,
  folderRowKey,
  isSameRowPlace,
  parseRowKey,
  topLevelIndexOf,
  type RowsInput
} from '../src/features/bots/folder-rows'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { readArrangement, type Arrangement } from '../src/store/folders'
import { FolderGroup } from '../src/features/bots/FolderGroup'
import { renderScreen } from './support/render'

/** A plate is a drawing, so it is hidden from accessibility and asked for as one. */
const HIDDEN = { includeHiddenElements: true } as const

/** The one style object a `FolderGroup` is given, for reading a corner off. */
const style = (node: { props: { style?: unknown } }): Record<string, number> =>
  (node.props.style ?? {}) as Record<string, number>

// Two modules, because the gateway card reaches for the provider directly
// rather than through the barrel.
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

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

/** Two loose chats around one folder holding two more. */
function arrangement(): Arrangement {
  return readArrangement(
    [
      { kind: 'chat', name: 'alpha' },
      { kind: 'folder', id: 'f1' },
      { kind: 'chat', name: 'omega' }
    ],
    [{ id: 'f1', name: 'Finance', bots: ['beta', 'gamma'] }]
  )
}

const rowsInput = (): RowsInput => ({
  arrangement: arrangement(),
  archived: {},
  collapsed: {},
  countsFor: () => ({ needsInput: false, unread: 0 }),
  mutes: {},
  now: 0
})

describe('a row key says what it is', () => {
  it('reads the two kinds of row and refuses the anchors that are not rows', () => {
    expect(parseRowKey(botRowKey('alpha'))).toEqual({ kind: 'bot', name: 'alpha' })
    expect(parseRowKey(folderRowKey('f1'))).toEqual({ kind: 'folder', id: 'f1' })
    // Positions, not rows: nobody drags "inside this folder, first".
    expect(parseRowKey('folderIn:f1')).toBeNull()
    expect(parseRowKey('folderEmpty:f1')).toBeNull()
    expect(parseRowKey('something-else')).toBeNull()
  })
})

describe('where a dragged folder lands', () => {
  it('turns a target inside another folder into that folder’s own place', () => {
    const list = arrangement()

    // Folders do not nest, so "into f1" can only mean "next to f1", which is
    // f1's own index in the top level.
    expect(topLevelIndexOf(list, { folderId: 'f1', index: 0 })).toBe(1)
    expect(topLevelIndexOf(list, { folderId: 'f1', index: 2 })).toBe(1)
    // A top-level target is already an answer.
    expect(topLevelIndexOf(list, { folderId: null, index: 2 })).toBe(2)
    // A container that has gone falls back to the end, like a drop past the
    // last row.
    expect(topLevelIndexOf(list, { folderId: 'gone', index: 0 })).toBe(3)
  })

  it('reads a drop immediately before or after itself as no move at all', () => {
    const list = arrangement()

    expect(isSameRowPlace(list, folderRowKey('f1'), { folderId: null, index: 1 })).toBe(true)
    expect(isSameRowPlace(list, folderRowKey('f1'), { folderId: null, index: 2 })).toBe(true)
    expect(isSameRowPlace(list, folderRowKey('f1'), { folderId: null, index: 0 })).toBe(false)
    expect(isSameRowPlace(list, folderRowKey('f1'), { folderId: null, index: 3 })).toBe(false)
    // And it still answers for a chat, which is the case it always answered.
    expect(isSameRowPlace(list, botRowKey('beta'), { folderId: 'f1', index: 1 })).toBe(true)
    expect(isSameRowPlace(list, botRowKey('beta'), { folderId: null, index: 0 })).toBe(false)
  })

  it('corrects the index for the row having been taken out', () => {
    const list = arrangement()

    // f1 sits at 1. Moving it DOWN past omega is index 3 with it still in, and
    // index 2 once it is out.
    expect(committedRowIndex(list, folderRowKey('f1'), { folderId: null, index: 3 })).toBe(2)
    // Moving it UP needs no correction: nothing below it has shifted.
    expect(committedRowIndex(list, folderRowKey('f1'), { folderId: null, index: 0 })).toBe(0)
  })

  it('offers a folder’s own row as an anchor, so there is a gap to aim at', () => {
    expect(dragAnchors(rowsInput()).map(anchor => anchor.key)).toEqual([
      'bot:alpha',
      'folder:f1',
      'folderIn:f1',
      'bot:beta',
      'bot:gamma',
      'bot:omega'
    ])
  })
})

const BOTS: Bot[] = ['alpha', 'beta', 'gamma', 'omega'].map(name => ({
  name,
  displayName: name,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0
}))

/**
 * A fresh gateway key per render.
 *
 * The layout is keyed by GATEWAY and persisted, and the key-value store lives
 * for the whole file — so a second `load('test-gateway')` reads back the folder
 * the first test made and the list grows one folder per test.
 */
let gatewayKeys = 0

async function renderList() {
  gatewayKeys += 1

  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots(BOTS)

  await act(async () => {
    await useChatLayoutStore.getState().load(`test-gateway-${gatewayKeys}`)
  })

  act(() => {
    useChatLayoutStore.getState().reconcile(['alpha', 'beta', 'gamma', 'omega'])
    const id = useChatLayoutStore.getState().addFolder('Finance')

    useChatLayoutStore.getState().moveToFolder('beta', id)
    useChatLayoutStore.getState().moveToFolder('gamma', id)
  })

  renderScreen(<BotsScreen />)

  await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy())

  return useChatLayoutStore.getState().folders[0]?.id as string
}

describe('the folder row on screen', () => {
  /**
   * There is no grip any more, and nothing took its place on the row.
   *
   * A folder was moved by revealing a 26pt column in edit mode and holding it.
   * The mode has gone, so the row carries nothing — the gesture is the row
   * itself, held.
   */
  it('carries no handle at all', async () => {
    const id = await renderList()

    expect(screen.queryByTestId(`folder-drag-handle-${id}`, { includeHiddenElements: true })).toBeNull()
    expect(screen.queryByTestId('bots-edit')).toBeNull()
  })

  /**
   * The pan handlers are on the row's own wrapper, unconditionally.
   *
   * That is what makes a hold able to become a drag: the responder is already
   * there, waiting to be armed, rather than appearing with a mode. The cell is
   * how the wrapper is found — `DragCell` names itself after the row key, and
   * the wrapper is the child inside it.
   */
  it('carries pan handlers on the row itself, with no mode to reveal them', async () => {
    const id = await renderList()

    const cell = await screen.findByTestId(`cell-${folderRowKey(id)}`, { includeHiddenElements: true })
    const wrapper = cell.children.find(
      child => typeof child !== 'string' && typeof child.props.onMoveShouldSetResponderCapture === 'function'
    )

    expect(wrapper).toBeTruthy()
  })
})

/**
 * A folder has to LOOK like a folder, which was the owner's whole report on R24:
 * the behaviour arrived and the drawing stayed a divider with a name on it.
 *
 * Three things carry that and each fails differently. The MARK says what kind of
 * thing this is. The PLATE says what is inside it — a closed folder is the whole
 * group and rounds all four corners, an open one is the top of something its
 * chats continue. And the STEP says those chats are in it rather than under it.
 */
describe('a folder is drawn as a container', () => {
  it('wears a folder mark and a chevron of its own', async () => {
    const id = await renderList()

    expect(screen.getByTestId(`folder-mark-${id}`, HIDDEN)).toBeTruthy()
    // One chevron that turns, rather than two glyphs swapped at the cut.
    expect(screen.getByTestId(`folder-chevron-${id}`, HIDDEN)).toBeTruthy()
  })

  it('is one plate the header opens and the last chat closes', async () => {
    const id = await renderList()

    const plate = style(screen.getByTestId(`folder-group-${id}`, HIDDEN))

    // Open: the top of something.
    expect(plate.borderTopLeftRadius).toBeGreaterThan(0)
    expect(plate.borderBottomLeftRadius).toBe(0)
    expect(plate.borderBottomWidth).toBe(0)

    // `beta` then `gamma` are inside; only the last one closes the plate.
    expect(style(screen.getByTestId('folder-member-beta', HIDDEN)).borderBottomLeftRadius).toBe(0)
    expect(style(screen.getByTestId('folder-member-gamma', HIDDEN)).borderBottomLeftRadius).toBeGreaterThan(0)

    // And a chat that is in no folder sits on no plate at all.
    expect(screen.queryByTestId('folder-member-alpha', HIDDEN)).toBeNull()
  })

  it('rounds all four corners once it is closed, because then it is the whole group', async () => {
    const id = await renderList()

    await act(async () => {
      fireEvent.press(screen.getByTestId(`folder-${id}`))
    })

    const plate = style(screen.getByTestId(`folder-group-${id}`, HIDDEN))

    expect(plate.borderBottomLeftRadius).toBeGreaterThan(0)
    expect(plate.borderBottomWidth).toBe(1)
    // The rows it was holding are gone with it.
    expect(screen.queryByTestId('folder-member-beta', HIDDEN)).toBeNull()
  })

  it('steps its chats in, so they read as being inside it', async () => {
    await renderList()

    expect(style(screen.getByTestId('folder-member-beta', HIDDEN)).paddingLeft).toBeGreaterThan(0)
  })
})

/**
 * Dropping INTO a folder has to look like dropping into a container.
 *
 * The plate takes the folder's own colour while a chat is over it. Asserted on
 * the plate rather than through a simulated drag, because what the drag decides —
 * which folder is being aimed at — is one lookup against the anchor's TARGET, and
 * that already has the anchors' own tests above it. What had no test at all was
 * whether being aimed at changes anything a reader can see.
 */
describe('the plate while a chat is over it', () => {
  it('takes the folder’s colour, and its resting state does not', () => {
    renderScreen(
      <>
        <FolderGroup colour="lime" edge="only" testID="resting" />
        <FolderGroup colour="lime" edge="only" targeted testID="targeted" />
      </>
    )

    const resting = style(screen.getByTestId('resting', HIDDEN))
    const targeted = style(screen.getByTestId('targeted', HIDDEN))

    expect(targeted.backgroundColor).not.toBe(resting.backgroundColor)
    expect(targeted.borderColor).not.toBe(resting.borderColor)
  })
})

describe('committing a folder drop', () => {
  it('moves the folder among the top-level rows', async () => {
    const id = await renderList()
    const before = useChatLayoutStore.getState().entries

    expect(before.map(entry => (entry.kind === 'folder' ? `folder:${entry.id}` : `bot:${entry.name}`))).toEqual([
      'bot:alpha',
      'bot:omega',
      `folder:${id}`
    ])

    act(() => {
      const state = useChatLayoutStore.getState()

      state.dropFolder(
        id,
        committedRowIndex({ entries: state.entries, folders: state.folders }, folderRowKey(id), {
          folderId: null,
          index: 0
        })
      )
    })

    expect(
      useChatLayoutStore
        .getState()
        .entries.map(entry => (entry.kind === 'folder' ? `folder:${entry.id}` : `bot:${entry.name}`))
    ).toEqual([`folder:${id}`, 'bot:alpha', 'bot:omega'])
  })
})
