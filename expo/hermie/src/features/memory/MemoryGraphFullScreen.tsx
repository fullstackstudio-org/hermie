/**
 * The memory graph, filling the window.
 *
 * The card on the page is square and as wide as a settings column, which on a
 * phone is about 350 points for a drawing laid out in 640 — so a graph of any
 * size arrives already too small to read, and the pinch that would fix it is
 * fighting a scroll view for the same fingers. This is the same drawing with
 * the whole window to itself: nothing scrolls underneath it, the gestures have
 * nowhere else to go, and the detail card has room to sit beside the picture
 * rather than under it.
 *
 * **Compact fills the screen; regular is a large panel.** That decision is
 * `useLayoutMode()` and therefore the SETTLED window width, never
 * `Platform.isPad` — the Mac IS the iPad build (ADR-0011), so the platform
 * cannot answer it and a Mac window dragged narrow really should get the phone's
 * arrangement. On a phone the picture wants every pixel; on an iPad or a Mac a
 * modal that swallowed a 15-inch display would be a worse view of the same
 * graph, not a better one, and it would lose the page it was opened from.
 *
 * Escape closes it, on the same stack every other surface registers with: this
 * component mounts above its own `Modal`, so it registers after whatever is
 * under it and the key reaches here first. A selected node does NOT take the
 * key — the card has its own close and a reader pressing Escape on a full-screen
 * view means the view.
 */
import { Modal, Pressable, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useLayoutMode } from '../../app/useLayoutMode'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { SCRIM_COLOR, TAP_SLOP } from '../../ui/tokens'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import type { MemoryGraph, MemoryGraphNode } from './graph-model'
import { MemoryGraphView } from './MemoryGraphView'
import { MemoryNodeCard } from './MemoryNodeCard'
import type { MemoryListing } from './model'
import { memoryStrings } from './strings'

/**
 * How much of a wide window the panel takes.
 *
 * Not `OVERLAY_MAX_WIDTH`: that is a settings column's width and this is a
 * picture. A graph wants area, and a fraction rather than a constant is what
 * keeps a 13-inch iPad and a 27-inch display both looking deliberate.
 */
const REGULAR_INSET = 0.08

export interface MemoryGraphFullScreenProps {
  visible: boolean
  graph: MemoryGraph
  /** Where a node's full text comes from; the node itself carries an excerpt. */
  listing: MemoryListing | null
  selected: MemoryGraphNode | null
  onSelect: (node: MemoryGraphNode | null) => void
  onClose: () => void
  testID?: string
}

export function MemoryGraphFullScreen({
  visible,
  graph,
  listing,
  selected,
  onSelect,
  onClose,
  testID = 'memory-graph-full'
}: MemoryGraphFullScreenProps) {
  const theme = useTheme()
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const regular = useLayoutMode() === 'regular'

  useEscapeKey(onClose, visible)
  useHardwareBack(onClose, visible)

  if (!visible) {
    return null
  }

  const inset = regular ? Math.round(Math.min(window.width, window.height) * REGULAR_INSET) : 0

  return (
    <Modal
      accessibilityViewIsModal
      animationType={theme.reduceMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible
    >
      {/*
        The backdrop is only a backdrop where there is something behind it to
        see. On a phone the panel covers the window, so a tappable scrim there
        would be a target with no surface area and an accessible name for a
        thing the reader cannot reach.
      */}
      <View style={{ backgroundColor: regular ? SCRIM_COLOR : theme.elevation.e0, flex: 1, padding: inset }}>
        {regular ? (
          <Pressable
            accessibilityLabel={memoryStrings.graph.full.dismiss}
            accessibilityRole="button"
            onPress={onClose}
            style={{ bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 }}
            testID={`${testID}-backdrop`}
          />
        ) : null}

        <View
          style={{
            backgroundColor: theme.elevation.e0,
            borderColor: regular ? theme.hairline : 'transparent',
            borderRadius: regular ? theme.radii.lg : 0,
            borderWidth: regular ? 1 : 0,
            flex: 1,
            overflow: 'hidden',
            // Same reason as the top: full screen the panel owns the home
            // indicator's strip and has to keep its own content off it.
            paddingBottom: regular ? 0 : insets.bottom,
            ...(regular ? theme.shadows.card : {})
          }}
          testID={testID}
        >
          <View
            style={{
              alignItems: 'center',
              borderBottomColor: theme.hairline,
              borderBottomWidth: 1,
              flexDirection: 'row',
              gap: theme.space.sm,
              paddingHorizontal: theme.space.lg,
              /*
                The real inset, not a constant. A full-screen `Modal` with
                `statusBarTranslucent` starts at the physical top of the
                display, so a fixed padding put the title under the clock on
                every phone whose sensor housing is deeper than the guess —
                which is all of them.
              */
              paddingTop: regular ? theme.space.md : insets.top + theme.space.xs,
              paddingBottom: theme.space.md
            }}
          >
            <Text style={{ flex: 1 }} variant="name">
              {memoryStrings.graph.full.title}
            </Text>
            <Pressable
              accessibilityLabel={memoryStrings.graph.full.close}
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onClose}
              testID={`${testID}-close`}
            >
              <Icon color={theme.colors.textMuted} name="close" size={ICON_SIZE.inline} />
            </Pressable>
          </View>

          {/*
            `fill`, and a layout size from the SHORTER side of the panel. The
            drawing is square and the `viewBox` letterboxes it, so seeding the
            layout with the short side is what keeps the nodes as far apart as
            the space really allows instead of as far apart as its width
            suggests.
          */}
          <MemoryGraphView
            fill
            graph={graph}
            onSelect={onSelect}
            selectedId={selected?.id ?? null}
            size={Math.max(320, Math.round(Math.min(window.width, window.height) - inset * 2))}
            testID={`${testID}-view`}
          />

          {selected ? (
            <View
              style={{
                borderTopColor: theme.hairline,
                borderTopWidth: 1,
                maxHeight: Math.round(window.height * 0.4),
                padding: theme.space.lg
              }}
            >
              <MemoryNodeCard
                graph={graph}
                listing={listing}
                node={selected}
                onClose={() => onSelect(null)}
                testID={`${testID}-detail`}
              />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}
