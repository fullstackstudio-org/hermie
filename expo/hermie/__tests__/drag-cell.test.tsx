/**
 * The cell a dragged row is drawn in.
 *
 * Two properties, and both of them are about a view the row cannot see. The row is
 * rendered inside a `FlatList` cell, so its own `onLayout` reports a box relative to
 * that cell — `y = 0`, for every row, at every scroll position — and a `zIndex` set
 * inside the cell orders nothing against the row above it. Both jobs belong to the
 * cell, and this pins that they are done there.
 *
 * The test renderer has no layout engine, so the measurement is driven by firing an
 * `onLayout` with the box a real cell would report. What is under test is not the
 * number: it is that the cell reports its OWN box under the row's key, and that it
 * still hands the same event to the list, which needs it to know how tall its
 * content is.
 */
import { render, fireEvent } from '@testing-library/react-native'
import { Text, View } from 'react-native'

import { DragCell, DragCellProvider, type DragCellState } from '../src/features/bots/DragCell'
import type { RowBox } from '../src/features/bots/drag-order'

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((all, part) => ({ ...all, ...flatten(part) }), {})
  }

  return (style ?? {}) as Record<string, unknown>
}

function renderCell(state: Partial<DragCellState>, key: string) {
  const measured: [string, RowBox][] = []
  const value: DragCellState = {
    liftedKey: state.liftedKey ?? null,
    measure: state.measure ?? ((cellKey, layout) => measured.push([cellKey, layout]))
  }

  const tree = render(
    <DragCellProvider value={value}>
      <DragCell item={{ key }} style={{ opacity: 1 }}>
        <View testID={`row-${key}`}>
          <Text>{key}</Text>
        </View>
      </DragCell>
    </DragCellProvider>
  )

  return { measured, tree }
}

describe('the lifted row is drawn above its neighbours', () => {
  it('raises the CELL, which is the row’s only sibling', () => {
    const { tree } = renderCell({ liftedKey: 'bot:beta' }, 'bot:beta')
    const style = flatten(tree.getByTestId('cell-bot:beta').props.style)

    expect(style.zIndex).toBe(2)
    // Android orders siblings by elevation, not by zIndex alone.
    expect(style.elevation).toBe(8)
    // A zIndex on a statically positioned element is ignored by CSS, so the web
    // build needs this said out loud.
    expect(style.position).toBe('relative')
  })

  it('leaves every other cell at the bottom of the stack', () => {
    const { tree } = renderCell({ liftedKey: 'bot:beta' }, 'bot:alpha')
    const style = flatten(tree.getByTestId('cell-bot:alpha').props.style)

    expect(style.zIndex).toBe(0)
    expect(style.elevation).toBe(0)
  })

  it('keeps the style the list gave the cell', () => {
    const { tree } = renderCell({ liftedKey: null }, 'bot:alpha')

    expect(flatten(tree.getByTestId('cell-bot:alpha').props.style).opacity).toBe(1)
  })
})

describe('the box a cell reports', () => {
  it('is its own, in the list’s coordinates, under the row’s key', () => {
    const { measured, tree } = renderCell({}, 'bot:gamma')

    fireEvent(tree.getByTestId('cell-bot:gamma'), 'layout', {
      nativeEvent: { layout: { height: 64, width: 320, x: 0, y: 128 } }
    })

    expect(measured).toEqual([['bot:gamma', { height: 64, y: 128 }]])
  })

  it('still hands the layout to the list, which is measuring its own content', () => {
    const onLayout = jest.fn()
    const value: DragCellState = { liftedKey: null, measure: () => undefined }
    const tree = render(
      <DragCellProvider value={value}>
        <DragCell item={{ key: 'bot:alpha' }} onLayout={onLayout}>
          <View testID="row" />
        </DragCell>
      </DragCellProvider>
    )

    fireEvent(tree.getByTestId('cell-bot:alpha'), 'layout', {
      nativeEvent: { layout: { height: 64, width: 320, x: 0, y: 0 } }
    })

    expect(onLayout).toHaveBeenCalledTimes(1)
  })
})
