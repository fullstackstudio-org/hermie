/**
 * The fold, and the reason its state does not live in the row.
 *
 * A disclosure that keeps its own `useState` is a bug with a delay on it: in a
 * virtualised list, scrolling an opened card out of the window unmounts the row, so
 * scrolling back re-mounts it collapsed. Nothing the reader did.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { useState } from 'react'
import { Text as RNText, View } from 'react-native'

import { AssistantBubble, ExpandedProvider, Fold, needsReadingTreatment, useExpanded } from '../../src/chat-ui'
import { assistantItem } from '../../src/chat-ui/fixtures'
import { foldCut, type FoldBlock } from '../../src/chat-ui/primitives/Fold'
import { FOLD_HEIGHT, FOLD_LINES } from '../../src/ui/tokens'
import { renderScreen, withProviders } from '../support/render'

/** A row that can be unmounted and re-mounted, the way `FlatList` does it. */
function Row({ id }: { id: string }) {
  const [expanded, toggle] = useExpanded(id)

  return (
    <View>
      <RNText onPress={toggle} testID={`toggle-${id}`}>
        toggle
      </RNText>
      <RNText testID={`state-${id}`}>{expanded ? 'open' : 'closed'}</RNText>
    </View>
  )
}

function Harness() {
  const [mounted, setMounted] = useState(true)

  return (
    <ExpandedProvider>
      <RNText onPress={() => setMounted(current => !current)} testID="virtualise">
        virtualise
      </RNText>
      {mounted ? <Row id="item-1" /> : null}
      <Row id="item-2" />
    </ExpandedProvider>
  )
}

describe('per-item expanded state', () => {
  it('survives the row being virtualised out and back', () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByTestId('toggle-item-1'))
    expect(screen.getByTestId('state-item-1').props.children).toBe('open')

    // Unmount the row, the way the list does when it scrolls out of the window.
    act(() => fireEvent.press(screen.getByTestId('virtualise')))
    expect(screen.queryByTestId('state-item-1')).toBeNull()

    act(() => fireEvent.press(screen.getByTestId('virtualise')))
    expect(screen.getByTestId('state-item-1').props.children).toBe('open')
  })

  it('keeps one item’s state out of another’s', () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByTestId('toggle-item-1'))

    expect(screen.getByTestId('state-item-1').props.children).toBe('open')
    expect(screen.getByTestId('state-item-2').props.children).toBe('closed')
  })

  it('closes again on a second tap', () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByTestId('toggle-item-1'))
    fireEvent.press(screen.getByTestId('toggle-item-1'))

    expect(screen.getByTestId('state-item-1').props.children).toBe('closed')
  })
})

describe('Fold', () => {
  /**
   * The test renderer lays nothing out, so `onLayout` never fires on its own and
   * the natural height stays 0. Firing it by hand is the only way to reach the
   * overflowing branch at all — which is also the honest limit of this test: it
   * proves the decision, not the pixels.
   */
  function grow(testID: string, height: number) {
    act(() => {
      fireEvent(screen.getByTestId(`${testID}-body`), 'layout', { nativeEvent: { layout: { height } } })
    })
  }

  function renderFold(height: number) {
    renderScreen(
      <ExpandedProvider>
        <Fold expanded={false} fadeTo="#ffffff" onToggle={jest.fn()} testID="fold">
          <RNText>body</RNText>
        </Fold>
      </ExpandedProvider>
    )

    grow('fold', height)
  }

  it('offers no control for a body that fits', () => {
    renderScreen(
      <ExpandedProvider>
        <Fold expanded={false} fadeTo="#ffffff" onToggle={jest.fn()} testID="fold">
          <RNText>short</RNText>
        </Fold>
      </ExpandedProvider>
    )

    expect(screen.queryByTestId('fold-toggle')).toBeNull()
  })

  it('offers the control once the body passes the cap', () => {
    renderFold(4000)

    expect(screen.getByTestId('fold-toggle')).toBeTruthy()
  })

  /**
   * A Mac report named this as one possible reason `Show more` sometimes did
   * not respond to a click: the fade sits over the last two and a half lines
   * of a clipped body, and if it ever reached past that into the toggle below
   * it, only part of the label would be clickable — which would explain a
   * miss that depends on exactly where the pointer landed.
   *
   * It does not, and this is why: the gradient is painted INSIDE the box that
   * `maxHeight` clips (`overflow: 'hidden'`), and the toggle is a SIBLING
   * rendered after that box closes, with its own `marginTop`. Walking up from
   * the toggle must never cross a view with that clip, and the gradient itself
   * is `pointerEvents="none"` even for the sliver of body it does sit over.
   */
  it('never sits under the fade: the toggle is outside the clipped box, and the fade lets touches through', () => {
    renderFold(4000)

    const gradient = screen.UNSAFE_getByType('ExpoLinearGradient')

    expect(gradient.props.pointerEvents).toBe('none')

    const root = screen.getByTestId('fold')
    let node = screen.getByTestId('fold-toggle').parent

    while (node && node !== root) {
      const style = node.props?.style
      const styles = Array.isArray(style) ? style : [style]

      expect(styles.some(entry => entry?.overflow === 'hidden')).toBe(false)
      node = node.parent
    }
  })

  /**
   * The owner's rule, and the reverse of what this file used to assert.
   *
   * A long reply folds WHILE it streams: the text grows inside the folded height
   * with `Show more` already under it. The exemption it replaces dumped the whole
   * reply out and collapsed it afterwards, and cost a visible lurch every time a
   * tool row sealed an interim bubble.
   */
  it('folds at the cap while the reply is still streaming', () => {
    const id = 'streaming-1'

    renderScreen(<AssistantBubble item={{ ...assistantItem, id, streaming: true, text: 'x'.repeat(4000) }} />)

    grow(`assistant-fold-${id}`, 4000)

    expect(screen.getByTestId(`assistant-fold-${id}-toggle`)).toBeTruthy()
  })

  /**
   * And it keeps growing once opened. The expanded flag belongs to the list, and
   * nothing in a turn clears it, so a reader who opened a streaming reply is not
   * re-collapsed by the next token.
   */
  it('keeps a streaming body open once the reader opened it', () => {
    const id = 'streaming-2'
    const item = { ...assistantItem, id, streaming: true, text: 'x'.repeat(4000) }
    const view = renderScreen(
      <ExpandedProvider>
        <AssistantBubble item={item} />
      </ExpandedProvider>
    )

    grow(`assistant-fold-${id}`, 4000)
    fireEvent.press(screen.getByTestId(`assistant-fold-${id}-toggle`))

    expect(screen.getByTestId(`assistant-fold-${id}-toggle`).props.accessibilityState.expanded).toBe(true)

    view.rerender(
      withProviders(
        <ExpandedProvider>
          <AssistantBubble item={{ ...item, text: 'x'.repeat(6000), version: 2 }} />
        </ExpandedProvider>
      )
    )
    grow(`assistant-fold-${id}`, 6000)

    expect(screen.getByTestId(`assistant-fold-${id}-toggle`).props.accessibilityState.expanded).toBe(true)
  })
})

/**
 * Where the cut lands.
 *
 * Two rules, and the second is the one that cannot be seen in a component test at
 * all: the clip is a whole number of LINES so the last visible line is a whole
 * line, and a table or a fenced code block is never cut THROUGH — half a row of
 * cells under a gradient is damage, not a fade, so the cut moves up to that
 * block's top and the block fades out entire.
 *
 * `foldCut` is exported for exactly this: asserting either rule off a rendered
 * bubble would mean measuring pixels the test renderer never lays out.
 */
describe('foldCut', () => {
  const LEADING = 25
  const LINES = FOLD_LINES.compact
  const block = (over: Partial<FoldBlock> = {}): FoldBlock => ({
    atomic: true,
    height: 120,
    index: 0,
    top: 0,
    ...over
  })

  it('cuts on a line multiple when nothing is in the way', () => {
    const cut = foldCut(LINES, LEADING, FOLD_HEIGHT.compact)

    expect(cut).toBe(LINES * LEADING)
    expect(cut % LEADING).toBe(0)
  })

  it('falls back to the fixed height when the caller knows no leading', () => {
    expect(foldCut(LINES, undefined, FOLD_HEIGHT.compact)).toBe(FOLD_HEIGHT.compact)
    expect(foldCut(LINES, 0, FOLD_HEIGHT.compact)).toBe(FOLD_HEIGHT.compact)
  })

  it('moves the cut up to the top of a block the line multiple would slice', () => {
    // The limit is 275; the table runs 200→320, so the cut falls inside it.
    const table = block({ height: 120, top: 200 })

    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [table])).toBe(200)
  })

  it('leaves the line multiple alone for a block that ends above it', () => {
    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [block({ height: 100, top: 100 })])).toBe(LINES * LEADING)
  })

  it('leaves the line multiple alone for a block that starts below it', () => {
    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [block({ height: 200, top: 300 })])).toBe(LINES * LEADING)
  })

  it('ignores a paragraph straddling the cut, which is what the gradient is for', () => {
    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [block({ atomic: false, height: 120, top: 200 })])).toBe(
      LINES * LEADING
    )
  })

  /**
   * The guard, not a preference: a table that opens the reply would move the cut
   * to nothing, and an empty fold with a `Show more` under it is worse than a
   * sliced table. Three lines is the floor.
   */
  it('never folds a block that starts at the top away to nothing', () => {
    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [block({ height: 900, top: 0 })])).toBe(LINES * LEADING)
    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [block({ height: 900, top: LEADING * 2 })])).toBe(
      LINES * LEADING
    )
    // At the floor exactly, the rule applies again.
    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, [block({ height: 900, top: LEADING * 3 })])).toBe(LEADING * 3)
  })

  it('takes the first straddling block when the reporter has holes in it', () => {
    // `useFoldBlocks` writes into a sparse array by index, so a caller may hand
    // over gaps — an undefined entry must not throw.
    const blocks = [undefined as unknown as FoldBlock, block({ height: 120, index: 1, top: 200 })]

    expect(foldCut(LINES, LEADING, FOLD_HEIGHT.compact, blocks)).toBe(200)
  })
})

describe('needsReadingTreatment', () => {
  it('leaves a short reply frosted', () => {
    expect(needsReadingTreatment('Done.')).toBe(false)
  })

  it('promotes a long one', () => {
    expect(needsReadingTreatment('x'.repeat(600))).toBe(true)
  })

  // A fenced block or a table qualifies at any length: both are wide machine text
  // that has to sit on a known surface to be readable at all.
  it('promotes a fenced block or a table however short', () => {
    expect(needsReadingTreatment('```\nnpm test\n```')).toBe(true)
    expect(needsReadingTreatment('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true)
  })
})

/**
 * What the fold TELLS the list when it opens.
 *
 * The number is the whole of the second `Show more` report. An inverted list
 * pins a growing cell's bottom edge, so the list can only keep the reader's line
 * still if it knows how much taller the row is about to be — and the fold is the
 * one place that is knowable before the layout happens, because `natural` is
 * measured on a view nothing constrains.
 */
describe('what a fold reports when it opens', () => {
  const LEADING = 20
  const NATURAL = 900
  // The test renderer reports a window at the regular breakpoint, which is the
  // branch `useFoldLines` takes — so this is the cut the rendered fold applies.
  const limit = FOLD_LINES.regular * LEADING

  function renderFold(onToggle: (id: string, growth: number) => void, expanded = false) {
    renderScreen(
      <ExpandedProvider onToggle={onToggle}>
        <Fold
          expanded={expanded}
          fadeTo="#fff"
          lineHeight={LEADING}
          onToggle={growth => onToggle('x', growth)}
          testID="fold"
        >
          <RNText>body</RNText>
        </Fold>
      </ExpandedProvider>
    )

    act(() => {
      fireEvent(screen.getByTestId('fold-body'), 'layout', { nativeEvent: { layout: { height: NATURAL } } })
    })
  }

  it('reports the height it is about to add', () => {
    const onToggle = jest.fn()

    renderFold(onToggle)
    fireEvent.press(screen.getByTestId('fold-toggle'))

    expect(onToggle).toHaveBeenCalledWith('x', NATURAL - limit)
  })

  it('reports the same height as a LOSS when it closes', () => {
    const onToggle = jest.fn()

    renderFold(onToggle, true)
    fireEvent.press(screen.getByTestId('fold-toggle'))

    expect(onToggle).toHaveBeenCalledWith('x', limit - NATURAL)
  })
})
