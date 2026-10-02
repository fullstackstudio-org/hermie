/**
 * The pasteboard in a browser. Ported from the Expo app's
 * `src/platform/clipboard.web.ts`.
 *
 * `copyToClipboard` keeps the source's synchronous contract (a menu item that
 * cannot usefully wait): it fires the write, swallows a rejection and says only
 * whether the API was there to try. `writeClipboard` is the awaited variant for
 * a control that confirms the copy (the code block's button), and resolves to
 * whether the browser actually took the text: it refuses without a secure
 * context, without a user gesture, or when permission is denied.
 */

/** The part of `navigator` this file uses, so a test can hand in its own. */
export interface ClipboardNavigator {
  readonly clipboard?: Pick<Clipboard, 'writeText'>
}

const pageNavigator = (): ClipboardNavigator | null => (typeof navigator === 'undefined' ? null : navigator)

export function copyToClipboard(text: string, nav: ClipboardNavigator | null = pageNavigator()): boolean {
  if (!text || !nav?.clipboard) {
    return false
  }

  try {
    void nav.clipboard.writeText(text).catch(() => undefined)

    return true
  } catch {
    return false
  }
}

export async function writeClipboard(text: string, nav: ClipboardNavigator | null = pageNavigator()): Promise<boolean> {
  if (!text || !nav?.clipboard) {
    return false
  }

  try {
    await nav.clipboard.writeText(text)

    return true
  } catch {
    return false
  }
}
