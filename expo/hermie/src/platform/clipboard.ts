/**
 * Put text on the pasteboard.
 *
 * Two lines of UIKit in the local module rather than a dependency. React Native's
 * own `Clipboard` is extracted from core and logs a deprecation warning the first
 * time the property is read, and `expo-clipboard` is not installed — adding a
 * package so that a context menu can copy a message would show up in
 * `THIRD_PARTY_LICENSES.md` for the rest of the project's life.
 *
 * Returns whether the text actually went anywhere, so a menu can tell the
 * difference between "copied" and "there is no pasteboard here" instead of
 * reporting success on Android. Nothing in the app shows a confirmation today;
 * the return value exists so the tests can.
 */
import { requireOptionalNativeModule } from 'expo'

type ClipboardModule = { setClipboardString?: (text: string) => void }

function nativeModule(): ClipboardModule | null {
  try {
    return requireOptionalNativeModule<ClipboardModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

export function copyToClipboard(text: string): boolean {
  if (!text) {
    return false
  }

  try {
    if (typeof mac?.setClipboardString !== 'function') {
      return false
    }

    mac.setClipboardString(text)

    return true
  } catch {
    // A pasteboard that refuses is not worth an error in front of somebody who
    // pressed Copy: the clipboard simply keeps what it had.
    return false
  }
}
