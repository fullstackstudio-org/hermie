/**
 * A text view a mouse can drag a selection across.
 *
 * `Text selectable` cannot: in the pinned React Native it is a long press that
 * presents an edit menu whose only action copies the whole paragraph, and
 * `RCTParagraphComponentView` holds no selection range for a drag to move. See
 * `src/markdown/attributed.ts` for the reading, and `HermieSelectableTextView`
 * in `expo/hermie/modules/hermie-mac` for the `UITextView` that does.
 *
 * Probed by FUNCTION for the same reason `context-menu.tsx` is: `requireNativeView`
 * throws for a view that is not registered, at module scope where nothing can
 * catch it usefully. `supportsSelectableText` was added to the module in the same
 * change as the view, so a binary that answers yes has it and a binary that
 * answers no is never asked.
 *
 * The caller always has something to render — see `SelectTextOverlay`, which
 * falls back to a nested `Text` tree. This module only says whether the better
 * surface exists.
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import type { StyleProp, ViewStyle } from 'react-native'

import type { SelectableRun } from '../markdown/attributed'

type SelectableProbe = { supportsSelectableText?: () => boolean }

function probe(): boolean {
  try {
    return typeof requireOptionalNativeModule<SelectableProbe>('HermieMac')?.supportsSelectableText === 'function'
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return false
  }
}

/** Whether this build can draw a drag-selectable rich text. */
export const HAS_NATIVE_SELECTABLE_TEXT = probe()

export interface NativeSelectableTextProps {
  runs: readonly SelectableRun[]
  fontSize: number
  textColor: string
  mutedColor: string
  linkColor: string
  codeBackground: string
  style?: StyleProp<ViewStyle>
  testID?: string
}

let cached: React.ComponentType<NativeSelectableTextProps> | null = null

/**
 * The native view, or `null` where there is none.
 *
 * Required lazily and once: there is no reason for a phone that will never
 * render one to find out at import time whether it could.
 */
export function nativeSelectableText(): React.ComponentType<NativeSelectableTextProps> | null {
  if (!HAS_NATIVE_SELECTABLE_TEXT) {
    return null
  }

  if (cached) {
    return cached
  }

  try {
    cached = requireNativeView<NativeSelectableTextProps>('HermieMac', 'HermieSelectableTextView')
  } catch {
    return null
  }

  return cached
}
