/**
 * A settled row is not rebuilt because the LIST re-rendered.
 *
 * `TranscriptRow` has been memoized since it was written, which keeps a settled
 * bubble's Markdown from being parsed again — and `VirtualizedList` never
 * reached it. The list re-renders on its own state every time the render window
 * moves, which during a fling is every frame; `CellRenderer` has no
 * `shouldComponentUpdate`, so it calls `renderItem` again, so the frame AROUND
 * the memoized row ran for every mounted row on every frame: its hooks, its
 * context-menu host and two wrapper views, sixty-odd rows at a time.
 *
 * That is the half of the 4× jank the numbers in docs/platform-notes.md are
 * about, and it is invisible from outside — the rendered output is identical
 * either way, which is exactly why it survived. So the thing asserted is the
 * WORK: the menu host is built once per row per distinct row, and a re-render
 * of the list with the same items does not build it again.
 */
import { TranscriptList } from '../src/chat-ui'
import { assistantItem, userItem } from '../src/chat-ui/fixtures'
import type { VisibleItem } from '../src/chat-ui/types'
import { renderScreen, withProviders } from './support/render'

const builds: string[] = []

jest.mock('../src/platform/context-menu', () => {
  const { View: RNView } = jest.requireActual('react-native')
  const actual = jest.requireActual('../src/platform/context-menu')

  return {
    ...actual,
    ContextMenuHost: ({ children, testID }: { children: React.ReactNode; testID?: string }) => {
      builds.push(testID ?? '')

      return <RNView testID={testID}>{children}</RNView>
    }
  }
})

const rows: VisibleItem[] = [
  { item: assistantItem, presentation: 'full' },
  { item: userItem, presentation: 'full' }
]

beforeEach(() => {
  builds.length = 0
})

describe('a transcript row', () => {
  it('is not rebuilt when the list re-renders with the same items', () => {
    const view = renderScreen(<TranscriptList items={rows} />)
    const first = builds.length

    expect(first).toBeGreaterThan(0)

    // A NEW array holding the SAME items: what the list hands `renderItem` every
    // time its own window state changes.
    view.rerender(withProviders(<TranscriptList items={[...rows]} />))

    expect(builds.length).toBe(first)
  })

  it('is rebuilt when its own item changes', () => {
    const view = renderScreen(<TranscriptList items={rows} />)
    const first = builds.length

    view.rerender(
      withProviders(
        <TranscriptList
          items={[{ item: { ...assistantItem, version: assistantItem.version + 1 }, presentation: 'full' }, rows[1]!]}
        />
      )
    )

    expect(builds.length).toBeGreaterThan(first)
  })
})
