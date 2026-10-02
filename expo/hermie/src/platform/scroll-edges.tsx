/**
 * A scrolling list without the platform's automatic edge blur.
 *
 * iOS 26 gives every `UIScrollView` a scroll edge effect, a blur UIKit draws where
 * content passes under a bar. Hermie draws its own: the chat header floats over the
 * top of the transcript and the composer over the bottom, both real glass, and
 * neither is a bar the scroll view was told about. So the platform's effect is a
 * second blur for the same job, placed by guesswork.
 *
 * On the Mac that guess was the whole conversation. The effect's view is the size
 * of the scroll view rather than of a band at its edge, and it fades in when the
 * POINTER enters — so every bubble went blurry as soon as the mouse crossed into
 * the chat, and stayed sharp on any machine without one. See
 * `HermieScrollEdgeView` for the hierarchy that was actually observed.
 *
 * `UIScrollEdgeEffect.isHidden` is the opt-out and React Native exposes no prop for
 * it, which is why this is a native wrapper rather than a style.
 *
 * Probed by FUNCTION, like every other optional native surface in this folder:
 * `requireNativeView` throws for a view that is not registered, at module scope
 * where nothing can catch it usefully, and an older binary running a newer bundle
 * is exactly the case that would hit it.
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import { type ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

type ScrollEdgeProbe = { supportsPlainScrollEdges?: () => boolean }

function probe(): boolean {
  try {
    return typeof requireOptionalNativeModule<ScrollEdgeProbe>('HermieMac')?.supportsPlainScrollEdges === 'function'
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}

/** Whether this build can take the platform's edge effect off a list. */
export const HAS_NATIVE_SCROLL_EDGES = probe()

export interface PlainScrollEdgesProps {
  style?: StyleProp<ViewStyle>
  children: ReactNode
}

type NativeProps = {
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}

/** Required lazily and once; see the note above about `requireNativeView` throwing. */
let cached: React.ComponentType<NativeProps> | null = null

function nativeHost(): React.ComponentType<NativeProps> | null {
  if (cached) {
    return cached
  }

  try {
    cached = requireNativeView<NativeProps>('HermieMac', 'HermieScrollEdgeView')
  } catch {
    return null
  }

  return cached
}

/**
 * Wrap the list, not the screen: the view takes the effect off the first scroll
 * view UNDER it, so what it contains decides which list it means.
 */
export function PlainScrollEdges({ children, style }: PlainScrollEdgesProps) {
  const Host = HAS_NATIVE_SCROLL_EDGES ? nativeHost() : null

  // A plain `View` where there is no host, so the layout is the same on every
  // platform and the seam costs one node rather than a branch at the call site.
  if (!Host) {
    return <View style={style}>{children}</View>
  }

  return <Host style={style}>{children}</Host>
}
