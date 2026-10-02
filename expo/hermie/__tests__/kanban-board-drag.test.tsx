/**
 * The board, as it is laid out around the drag.
 *
 * The drag is an ADDITION on a wide window, and the one thing that must not
 * have happened is the menu quietly becoming the narrow layout's consolation
 * prize. It is the only way to move a card under VoiceOver, from a keyboard
 * and on a phone, so it is asserted on both widths — and the hint that
 * describes the gesture is asserted only on the width where the gesture
 * exists, because a line telling a phone to drop a card on a column it cannot
 * see is worse than no line.
 *
 * What the drop resolves to is in `kanban-card-drag.test.ts`, without a
 * renderer. This file is about what is on screen.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useWindowDimensions } from 'react-native'

import { renderScreen } from './support/render'
import { KanbanScreen } from '../src/features/kanban'
import { isReportable, type DropResolution } from '../src/features/kanban/card-drag'
import { kanbanStrings } from '../src/features/kanban/strings'

const mockHttpGet = jest.fn()
const mockHttpPost = jest.fn()
const mockHttpPatch = jest.fn()
const mockHttpDelete = jest.fn()

jest.mock('../src/gateway', () => {
  const http = {
    delete: (...args: unknown[]) => mockHttpDelete(...args),
    get: (...args: unknown[]) => mockHttpGet(...args),
    patch: (...args: unknown[]) => mockHttpPatch(...args),
    post: (...args: unknown[]) => mockHttpPost(...args)
  }

  return { useGateway: () => ({ connection: null, http }) }
})

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const card = (id: string, title: string, status: string) => ({
  id,
  title,
  status,
  body: null,
  assignee: null,
  priority: 0,
  created_at: 1_700_000_000,
  latest_summary: null,
  comment_count: 0
})

/** `/board`'s answer: the eight fixed columns, two of them with a card in. */
const BOARD = {
  assignees: ['hermie'],
  columns: [
    { name: 'triage', tasks: [] },
    { name: 'todo', tasks: [card('t_1', 'Read the logs', 'todo')] },
    { name: 'scheduled', tasks: [] },
    { name: 'ready', tasks: [] },
    { name: 'running', tasks: [card('t_2', 'Indexing', 'running')] },
    { name: 'blocked', tasks: [] },
    { name: 'review', tasks: [] },
    { name: 'done', tasks: [] }
  ]
}

beforeEach(() => {
  jest.clearAllMocks()
  mockHttpGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/plugins/kanban/boards')) {
      return { boards: [{ slug: 'main', name: 'Main', description: null, is_current: true, total: 2 }] }
    }

    return BOARD
  })
})

/** Open the one board, at this window width. */
async function openBoard(width: number) {
  mockDimensions.mockReturnValue({ width, height: 900, scale: 2, fontScale: 1 })

  const view = renderScreen(<KanbanScreen onClose={() => undefined} />)

  await waitFor(() => expect(screen.getByTestId('kanban-board-main')).toBeTruthy())

  fireEvent.press(screen.getByTestId('kanban-board-main'))

  await waitFor(() => expect(screen.getByTestId('kanban-card-t_1')).toBeTruthy())

  return view
}

describe('the drag does not take the menu’s place', () => {
  it('keeps Move to… on every card on a wide board', async () => {
    await openBoard(1024)

    // The card that can move, and the one in a column it may leave.
    expect(screen.getByTestId('kanban-move-t_1')).toBeTruthy()
    expect(screen.getByTestId('kanban-move-t_2')).toBeTruthy()
  })

  it('keeps Move to… on a phone, where there is no drag at all', async () => {
    await openBoard(390)

    expect(screen.getByTestId('kanban-move-t_1')).toBeTruthy()
  })

  it('tells a wide window about the gesture and a narrow one nothing', async () => {
    await openBoard(1024)
    expect(screen.getByTestId('kanban-drag-hint').props.children).toBe(kanbanStrings.dragHint)

    screen.unmount()

    await openBoard(390)
    expect(screen.queryByTestId('kanban-drag-hint')).toBeNull()
  })

  it('believes its own layout over the window it is in', async () => {
    // The iPad's Settings overlay: a 1032pt window with the board drawn in
    // about half of it. Asking the window laid eight 260pt columns out inside
    // 516pt of panel, and the second one was cut off at the panel's edge with
    // its cards and its New card button out of reach.
    await openBoard(1024)
    expect(screen.getByTestId('kanban-drag-hint')).toBeTruthy()

    fireEvent(screen.getByTestId('kanban-board-scroll'), 'layout', {
      nativeEvent: { layout: { height: 900, width: 516, x: 0, y: 0 } }
    })

    await waitFor(() => expect(screen.queryByTestId('kanban-drag-hint')).toBeNull())
  })

  it('goes back to side by side when the panel is given the room', async () => {
    await openBoard(1024)

    fireEvent(screen.getByTestId('kanban-board-scroll'), 'layout', {
      nativeEvent: { layout: { height: 900, width: 516, x: 0, y: 0 } }
    })
    await waitFor(() => expect(screen.queryByTestId('kanban-drag-hint')).toBeNull())

    fireEvent(screen.getByTestId('kanban-board-scroll'), 'layout', {
      nativeEvent: { layout: { height: 900, width: 980, x: 0, y: 0 } }
    })
    await waitFor(() => expect(screen.getByTestId('kanban-drag-hint')).toBeTruthy())
  })

  it('still says why three columns refuse a card, on both widths', async () => {
    await openBoard(1024)
    expect(screen.getByTestId('kanban-locked-note')).toBeTruthy()

    screen.unmount()

    await openBoard(390)
    expect(screen.getByTestId('kanban-locked-note')).toBeTruthy()
  })

  it('marks the dispatcher’s columns as non-targets and leaves the rest idle', async () => {
    await openBoard(1024)

    // Nothing is being dragged, so every band is idle — the refusal is a state
    // the band enters when a card lifts, not a permanent grey.
    expect(screen.queryAllByTestId('kanban-column-refused')).toHaveLength(0)
    expect(screen.queryAllByTestId('kanban-column-idle')).toHaveLength(8)
  })
})

describe('a drop that changes nothing sends nothing', () => {
  it.each([
    [{ kind: 'outside' } as DropResolution, false],
    [{ column: 'todo', kind: 'origin' } as DropResolution, false],
    [{ column: 'done', kind: 'move' } as DropResolution, true],
    [{ column: 'running', kind: 'refused' } as DropResolution, true]
  ])('reports %j: %s', (resolution, reported) => {
    expect(isReportable(resolution)).toBe(reported)
  })

  it('never PATCHes while the board is merely being looked at', async () => {
    await openBoard(1024)

    // The whole point of refusing a locked column in the client: a reader who
    // aims at Running costs the gateway nothing.
    expect(mockHttpPatch).not.toHaveBeenCalled()
  })
})
