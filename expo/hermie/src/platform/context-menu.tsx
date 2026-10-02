/**
 * A secondary click that opens the PLATFORM's menu.
 *
 * React Native has no secondary-click event. `Pressable` offers `onLongPress`
 * and nothing else, so before this a right click on a Mac or an iPad trackpad did
 * not reach the app at all, and the only menu the app could open was one it drew
 * itself. The owner asked for the other thing: right-click a chat row, right-click
 * a message, and get the menu the rest of the system uses.
 *
 * `UIContextMenuInteraction` is that menu, and the local module in
 * `expo/hermie/modules/hermie-mac` wraps it as a host view. What comes with it is
 * the whole reason not to draw one: the system's glass and placement, arrow-key
 * navigation, Return to choose, Escape to dismiss, and the row lifting into a
 * preview so the menu visibly belongs to it.
 *
 * ## Availability, and why it is probed by a FUNCTION
 *
 * `HAS_NATIVE_CONTEXT_MENU` is false on Android, in the Jest environment and on
 * any build whose native side predates this change — and that last case is the
 * one worth the trick. `requireNativeView` throws when a view is not registered,
 * and it throws at module scope where nothing can catch it usefully. So the probe
 * asks the MODULE whether it has `setClipboardString`, a function added in the
 * same change as the view: a binary that answers yes has the view, and a binary
 * that answers no is never asked for it.
 *
 * ## The fallback is the caller's, not this module's
 *
 * `ContextMenuHost` renders its children inside the native host when there is one
 * and renders them bare when there is not. It does NOT fall back to a sheet,
 * because a sheet needs a place to live and a visibility flag, and the screen
 * already has both — see `RowMenu`, which stays exactly as it was for Android.
 * The call site keeps its `onLongPress` for that path and drops it for this one.
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import { type ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import type { MenuItem } from '../ui/menu'

type ClipboardProbe = { setClipboardString?: (text: string) => void }

function probe(): boolean {
  try {
    return typeof requireOptionalNativeModule<ClipboardProbe>('HermieMac')?.setClipboardString === 'function'
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}

/** Whether a secondary click can open a system menu on this build. */
export const HAS_NATIVE_CONTEXT_MENU = probe()

export interface ContextMenuHostProps {
  items: readonly MenuItem[]
  onSelect: (id: string) => void
  /** Shown as the menu's own heading. A row menu uses the chat's name. */
  menuTitle?: string
  /** False leaves the gesture alone, so a row being dragged opens nothing. */
  enabled?: boolean
  /**
   * Whether the pointer may highlight this host while it merely passes over.
   *
   * True for a LIST ROW — that highlight is how the rest of the system says a
   * row is a thing you can act on. False for anything as large as a message: the
   * owner's report from the Mac is a blurred platter the size of a reply
   * appearing under the mouse on its way across the conversation, which is this
   * effect at a size it was never meant for. Only `TranscriptList` turns it off.
   */
  hoverEffect?: boolean
  /**
   * The radius the CHILD is drawn with, so the platform's highlight is cut to
   * the same shape.
   *
   * UIKit's own is a rectangle around the whole host, which under a chat row
   * reads as a square grey block behind a row whose selected state is a rounded
   * pill — the owner's report. The host cannot measure its child's corners, so
   * the row hands over the radius it already uses.
   */
  cornerRadius?: number
  /**
   * Let a nested button escape this host's menu instead of racing it for the same click.
   *
   * False for a LIST ROW, where the row itself is the button a secondary click is supposed to
   * land on — `BotRow`, a cron row. True only where the host's target holds small controls of its
   * own: `TranscriptList` is the one caller, because a reply's `Show more`, a tool card's own
   * disclosure and a reasoning toggle are `Pressable`s living INSIDE the row the menu belongs to,
   * not the row itself. See `HermieContextMenuView.setPassThroughButtons` for the mechanism —
   * a click that lands on one of those is never offered to the interaction at all, rather than
   * being raced against it and sometimes lost, which was the owner's report on a Mac: `Show more`
   * sometimes did not respond to a click.
   */
  passThroughButtons?: boolean
  style?: StyleProp<ViewStyle>
  children: ReactNode
  testID?: string
}

type NativeProps = {
  items: readonly MenuItem[]
  menuTitle?: string
  enabled?: boolean
  hoverEffect?: boolean
  cornerRadius?: number
  passThroughButtons?: boolean
  style?: StyleProp<ViewStyle>
  onSelect?: (event: { nativeEvent: { id: string } }) => void
  children?: ReactNode
  testID?: string
}

/**
 * Required lazily and once, because `requireNativeView` throws for a view that is
 * not registered and there is no reason to find that out on a phone that will
 * never render one.
 */
let cached: React.ComponentType<NativeProps> | null = null

function nativeHost(): React.ComponentType<NativeProps> | null {
  if (cached) {
    return cached
  }

  try {
    cached = requireNativeView<NativeProps>('HermieMac', 'HermieContextMenuView')
  } catch {
    return null
  }

  return cached
}

export function ContextMenuHost({
  children,
  cornerRadius,
  enabled = true,
  hoverEffect = true,
  items,
  menuTitle,
  onSelect,
  passThroughButtons = false,
  style,
  testID
}: ContextMenuHostProps) {
  const Host = HAS_NATIVE_CONTEXT_MENU && items.length ? nativeHost() : null

  // No host means no wrapper at all, not an empty one. A view per chat row and per
  // transcript row on a platform that cannot use it is a measurable cost on the two
  // longest lists in the app — and a `testID` on it would put a node in every
  // snapshot and every `queryAllByTestId` sweep that has nothing to do with the
  // screen under test.
  if (!Host) {
    return style ? <View style={style}>{children}</View> : <>{children}</>
  }

  return (
    <Host
      {...(cornerRadius === undefined ? {} : { cornerRadius })}
      enabled={enabled}
      hoverEffect={hoverEffect}
      items={items}
      {...(menuTitle ? { menuTitle } : {})}
      onSelect={event => onSelect(event.nativeEvent.id)}
      passThroughButtons={passThroughButtons}
      style={style}
      testID={testID}
    >
      {children}
    </Host>
  )
}
