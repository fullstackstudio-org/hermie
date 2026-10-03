/**
 * The transcript: every visible row of a chat, bottom-anchored.
 *
 * The boundary is the props. A chat screen hands in the rows `visibleItems`
 * gave it and a `renderItem`, and hears back when the reader nears the top
 * (load older history) and when the list starts or stops following the bottom
 * (the "jump to newest" control). How the rows are laid out behind that is
 * this file's business; plan decision W8 pre-approves swapping the inside for
 * a virtualiser without touching a caller.
 *
 * What is inside now (the W-8 spike measured it; the numbers are in
 * `native/web/README.md`, "Measured"):
 *
 *  - **Every row is in the DOM** and the browser skips the work for the rows
 *    far from the viewport: `content-visibility: auto` on each chunk of rows
 *    (below), with a `contain-intrinsic-size` that is the sum of its rows'
 *    per-kind estimates (`ROW_ESTIMATES`). A chunk the browser has drawn once
 *    remembers its real height (`auto`), so scrolling back over it does not
 *    change the content's height a second time. On the chunk and not on each
 *    row because Chromium checks every `content-visibility: auto` element's
 *    distance to the viewport on every frame that changed layout: with one per
 *    row, a 5,000-row chat spent most of its frame there (the spike's trace).
 *  - **Bottom anchoring and the reader's place** are `scroll-anchor.ts`, run
 *    on every size change of a chunk, of all the rows or of the viewport
 *    (`ResizeObserver`, after layout and before paint), and on every scroll.
 *  - **A delta re-renders one row.** Rows are grouped into stable chunks
 *    (`row-chunks.ts`), each memoised on its rows, and every row is memoised on
 *    its id, version, presentation and whether the selectors took its thought
 *    away. The engine bumps `version` on every change to an item, so that is
 *    an exact change key. `renderItem` is compared by identity: a caller keeps
 *    it stable (`useCallback`) or every row renders again.
 */
import { type VisibleItem } from '@hermie/transcript'
import {
  type CSSProperties,
  memo,
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { layoutClock, type ResizeWatch } from '../../platform/layout'
import { assignChunks, type ChunkAssignment, emptyAssignment } from './row-chunks'
import { ScrollAnchor, type RowPosition, type ScrollSurface } from './scroll-anchor'
import './transcript-list.css'

export interface TranscriptListProps {
  /** What `visibleItems` returned, oldest first. */
  rows: readonly VisibleItem[]
  /** Draws one row. Keep it stable across renders. */
  renderItem: (row: VisibleItem) => ReactNode
  /** The reader is near the oldest row: time to load older history. Called once per oldest row. */
  onReachTop?: () => void
  /** The list started (`true`) or stopped (`false`) following the newest row. It starts following. */
  onStickChange?: (stuck: boolean) => void
  /** The accessible name of the transcript region. */
  label?: string
  /** A reply is streaming into the list: `aria-busy`, so a reader of the log is not interrupted by every delta. */
  busy?: boolean
  /** What the list can be told to do (`jumpToLatest`); the props stay the whole of what it is told. */
  listRef?: Ref<TranscriptListHandle>
}

/** The one command the list takes besides its rows. */
export interface TranscriptListHandle {
  /** Go to the newest row and follow it from now on (the "jump to latest" control). */
  jumpToLatest(): void
}

/** What a chunk and its rows share with the list. One object for the list's life. */
interface ListShared {
  /** Row key to its element, for the anchor. */
  rowElements: Map<string, HTMLElement>
  resize: ResizeWatch
}

const keyOf = (row: VisibleItem): string => row.item.id

/** The fields the selectors may change without a new version. */
const thoughtOf = (row: VisibleItem): unknown =>
  row.item.kind === 'assistant' ? (row.item.reasoning ?? row.item.reasoningVerbose) : undefined

/** Whether two rows would draw the same. */
export function sameRow(a: VisibleItem, b: VisibleItem): boolean {
  return (
    a.presentation === b.presentation &&
    (a.item === b.item ||
      (a.item.id === b.item.id && a.item.version === b.item.version && thoughtOf(a) === thoughtOf(b)))
  )
}

interface RowProps {
  row: VisibleItem
  renderItem: TranscriptListProps['renderItem']
  shared: ListShared
}

const Row = memo(
  function Row({ row, renderItem, shared }: RowProps) {
    const key = row.item.id
    const register = useCallback(
      (element: HTMLDivElement | null) => {
        if (!element) {
          return
        }
        shared.rowElements.set(key, element)
        return () => {
          if (shared.rowElements.get(key) === element) {
            shared.rowElements.delete(key)
          }
        }
      },
      [key, shared]
    )

    return (
      <div
        ref={register}
        className="transcript-list__row"
        data-row-key={key}
        data-kind={row.item.kind}
        data-presentation={row.presentation}
      >
        {renderItem(row)}
      </div>
    )
  },
  (a, b) => a.renderItem === b.renderItem && a.shared === b.shared && sameRow(a.row, b.row)
)

/**
 * How tall a row of each kind is before anybody has seen it, in CSS pixels:
 * close to the item views' typical heights. A chunk nobody has seen yet is laid
 * out at the sum of its rows' estimates; a chunk that has been drawn once keeps
 * its real height. The closer these are, the less the scrollbar thumb moves
 * while the reader scrolls through history for the first time; the reader's
 * place never depends on them (`scroll-anchor.ts`).
 */
export const ROW_ESTIMATES: Readonly<Record<VisibleItem['item']['kind'], number>> = {
  user: 72,
  bot_dm_in: 72,
  assistant: 168,
  clarify: 168,
  approval: 132,
  cron_delivery: 132,
  tool: 52,
  bot_dm_out: 52,
  subagent_group: 52,
  status: 36,
  notice: 36
}

export function estimatedHeight(row: VisibleItem): number {
  switch (row.presentation) {
    case 'hidden-placeholder':
      return 0
    case 'chip':
      return 36
    default:
      return ROW_ESTIMATES[row.item.kind] ?? 96
  }
}

interface ChunkProps {
  rows: VisibleItem[]
  renderItem: TranscriptListProps['renderItem']
  shared: ListShared
}

const Chunk = memo(
  function Chunk({ rows, renderItem, shared }: ChunkProps) {
    const watch = useCallback(
      (element: HTMLDivElement | null) => {
        if (!element) {
          return
        }
        shared.resize.watch(element)
        return () => shared.resize.unwatch(element)
      },
      [shared]
    )

    const estimate = rows.reduce((sum, row) => sum + estimatedHeight(row), 0)
    // A custom property set through the CSSOM, which the document's policy
    // allows; `transcript-list.css` turns it into the chunk's intrinsic size.
    const style = { '--transcript-chunk-estimate': `${estimate}px` } as CSSProperties

    return (
      <div ref={watch} className="transcript-list__chunk" style={style}>
        {rows.map(row => (
          <Row key={row.item.id} row={row} renderItem={renderItem} shared={shared} />
        ))}
      </div>
    )
  },
  (a, b) =>
    a.renderItem === b.renderItem &&
    a.shared === b.shared &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, index) => sameRow(row, b.rows[index] as VisibleItem))
)

/** The first child whose bottom edge is below `y` (children in document order). */
function firstBelow(children: HTMLCollection, y: number): Element | undefined {
  let low = 0
  let high = children.length - 1
  let found: Element | undefined

  while (low <= high) {
    const middle = (low + high) >> 1
    const child = children[middle] as Element
    if (child.getBoundingClientRect().bottom > y) {
      found = child
      high = middle - 1
    } else {
      low = middle + 1
    }
  }

  return found
}

/** The anchor's view of the real scroller. */
function domSurface(
  scroller: HTMLElement,
  rowsRoot: HTMLElement,
  rowElements: Map<string, HTMLElement>
): ScrollSurface {
  const viewportTop = () => scroller.getBoundingClientRect().top + scroller.clientTop

  return {
    scrollTop: () => scroller.scrollTop,
    setScrollTop: value => {
      scroller.scrollTop = value
    },
    scrollHeight: () => scroller.scrollHeight,
    clientHeight: () => scroller.clientHeight,
    firstVisible(): RowPosition | null {
      const top = viewportTop()
      const chunk = firstBelow(rowsRoot.children, top)
      const row = chunk && firstBelow(chunk.children, top)
      const key = row instanceof HTMLElement ? row.dataset.rowKey : undefined
      return row && key !== undefined ? { key, top: row.getBoundingClientRect().top - top } : null
    },
    rowTop(key) {
      const element = rowElements.get(key)
      return element?.isConnected ? element.getBoundingClientRect().top - viewportTop() : null
    },
    firstKey() {
      const first = rowsRoot.firstElementChild?.firstElementChild
      return first instanceof HTMLElement ? (first.dataset.rowKey ?? null) : null
    }
  }
}

export function TranscriptList({
  rows,
  renderItem,
  onReachTop,
  onStickChange,
  label,
  busy,
  listRef
}: TranscriptListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<ScrollAnchor | null>(null)
  const chunksRef = useRef<ChunkAssignment<VisibleItem>>(emptyAssignment())
  const rowsSeen = useRef<readonly VisibleItem[] | null>(null)

  useImperativeHandle(listRef, () => ({ jumpToLatest: () => anchorRef.current?.stickToBottom() }), [])

  // One object for the list's life, so memoised chunks and rows never see it change.
  const [shared] = useState<ListShared>(() => ({
    rowElements: new Map(),
    resize: layoutClock.observeResize(() => anchorRef.current?.settle())
  }))

  if (rowsSeen.current !== rows) {
    chunksRef.current = assignChunks(chunksRef.current, rows, keyOf)
    rowsSeen.current = rows
  }

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const rowsRoot = rowsRef.current
    if (!scroller || !rowsRoot) {
      return
    }

    const created = new ScrollAnchor(domSurface(scroller, rowsRoot, shared.rowElements))
    anchorRef.current = created
    // The viewport, all the rows together (a chunk removed above the reader
    // changes no remaining chunk), and each chunk (`Chunk` watches its own).
    shared.resize.watch(scroller)
    shared.resize.watch(rowsRoot)

    const onScroll = () => created.readerScrolled()
    scroller.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      shared.resize.unwatch(scroller)
      shared.resize.unwatch(rowsRoot)
      anchorRef.current = null
    }
  }, [shared])

  // After every commit the newest callbacks go to the anchor, so it never
  // depends on their identity. Settling is the resize watch's job: anything a
  // commit moves changes the size of a chunk or of all the rows, and the watch
  // reports it after the frame's own layout, so settling here as well would
  // force a second layout on every frame of a streaming reply. Without a watch
  // (no `ResizeObserver`), this is the only place it can happen.
  useLayoutEffect(() => {
    const current = anchorRef.current
    if (current) {
      current.setCallbacks({ onReachTop, onStickChange })
      if (!shared.resize.observing) {
        current.settle()
      }
    }
  })

  return (
    <div
      ref={scrollerRef}
      className="transcript-list"
      role="log"
      aria-label={label}
      aria-busy={busy ? true : undefined}
      tabIndex={0}
    >
      <div className="transcript-list__content">
        <div className="transcript-list__spacer" />
        <div ref={rowsRef} className="transcript-list__rows">
          {chunksRef.current.chunks.map(chunk => (
            <Chunk key={chunk.id} rows={chunk.rows} renderItem={renderItem} shared={shared} />
          ))}
        </div>
      </div>
    </div>
  )
}
