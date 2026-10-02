/**
 * The `FlatList` cell a chat row lives in, and the two jobs only a cell can do.
 *
 * ## Why this exists at all
 *
 * `VirtualizedList` wraps every item in a `View` of its own before putting it in
 * the content container. Nothing in the item can see that wrapper, and two things
 * the drag needs are true of the wrapper and false of everything inside it:
 *
 *  - **It is where the row's position is.** `onLayout` reports a box relative to
 *    the parent, so a row measuring itself inside its cell reports `y = 0` — every
 *    row, at every scroll position. `drag-order.ts` compares those boxes against
 *    the finger, so with nothing but zeroes the only answers it could ever give
 *    were "above the first row" and "past the last one". The cell's own `onLayout`
 *    is relative to the content container, which is the space the finger is
 *    translated into.
 *  - **It is the row's sibling.** `zIndex` and `elevation` order siblings. A lifted
 *    row raised inside its cell is still drawn inside a cell that comes before the
 *    next one, so it goes UNDER its neighbour — which is what a reader sees as a
 *    row that slides beneath the list. Raising the CELL is what puts it on top, and
 *    it is one style on one view rather than a second copy of the row in an overlay.
 *
 * ## Why a context rather than a prop
 *
 * `CellRendererComponent` is remounted whenever its identity changes, so it cannot
 * close over the drag: a component rebuilt when a drag starts would tear down and
 * rebuild every visible row at exactly the wrong moment. The component is defined
 * once, at module scope, and reads the drag through a context — which re-renders
 * the cells, and only the cells, when the lifted row changes.
 */
import { createContext, memo, useContext, type ReactNode } from 'react'
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'

import type { RowBox } from './drag-order'

export interface DragCellState {
  /** The anchor key of the lifted row, or null. */
  liftedKey: string | null
  /** Report a cell's box in the list's content coordinates. */
  measure: (key: string, layout: RowBox) => void
}

const NOOP: DragCellState = { liftedKey: null, measure: () => undefined }

const DragCellContext = createContext<DragCellState>(NOOP)

export const DragCellProvider = DragCellContext.Provider

/**
 * The raised cell.
 *
 * `position: 'relative'` is redundant on the native platforms and is not on the
 * web: a `zIndex` on a statically positioned element is ignored by CSS, and
 * `react-native-web` only guarantees the base `View` style, not what a cell style
 * layers on top of it. `elevation` is Android's own z-order for the same reason —
 * it orders siblings there, and a shadow that arrives with it is the same shadow
 * the lifted row already draws.
 */
const LIFTED: ViewStyle = { elevation: 8, position: 'relative', zIndex: 2 }

/** Not `{}`: a style that appears and disappears is a style that can be forgotten. */
const RESTING: ViewStyle = { elevation: 0, position: 'relative', zIndex: 0 }

interface CellProps {
  children: ReactNode
  item: { key?: string } | null | undefined
  onLayout?: ((event: LayoutChangeEvent) => void) | undefined
  style?: StyleProp<ViewStyle>
}

export const DragCell = memo(function DragCell({ children, item, onLayout, style, ...rest }: CellProps) {
  const { liftedKey, measure } = useContext(DragCellContext)
  const key = item?.key ?? ''
  const lifted = key !== '' && key === liftedKey

  return (
    <View
      {...rest}
      /*
       * Named after the row it holds, which is the only handle anything outside
       * this file has on a cell: `react-native-web` renders it as a `data-testid`,
       * so the z-order this component sets can be read off the DOM in a browser as
       * well as off the tree in a test.
       */
      testID={key === '' ? undefined : `cell-${key}`}
      onLayout={event => {
        // The list's own measurement first, and unconditionally: a cell renderer
        // that swallows it stops `VirtualizedList` from ever knowing how tall its
        // content is, and the list would scroll to nowhere.
        onLayout?.(event)

        if (key !== '') {
          measure(key, { height: event.nativeEvent.layout.height, y: event.nativeEvent.layout.y })
        }
      }}
      style={[style, lifted ? LIFTED : RESTING]}
    >
      {children}
    </View>
  )
})
