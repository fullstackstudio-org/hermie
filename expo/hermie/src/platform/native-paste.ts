/**
 * Reading the general pasteboard for an attachment, on ⌘V.
 *
 * The keyboard shortcut itself carries no payload — `desktop-shortcuts.ts` only
 * reports that ⌘V happened, the way it reports every other chord, from a
 * GameController handler below the responder chain (see `HermieMacModule.swift`).
 * This is the second half, and it does not intercept anything: a plain-text ⌘V
 * still reaches the composer's `UITextView` through the ordinary responder chain
 * and inserts text exactly as it always has, because nothing here ever touches
 * that path. What this answers is the one thing UIKit's own paste cannot — an
 * image or a file the pasteboard is holding — by asking `HermieMac` to read
 * `UIPasteboard.general` and copy whatever it finds into a temporary directory,
 * in the same `{uri, name, size, mimeType}` shape `file-drop.shared.ts` already
 * speaks. A pasted file reaches the composer's existing upload pipeline
 * unchanged; a pasted image reaches the resize pipeline the same way a dropped
 * one would, once `attachments.ts` has asked it for its pixel size.
 *
 * `React Native's TextInput does not surface a pasted image at all` is the
 * reason this module exists in the first place — see the module comment on
 * `keyboard-modifiers.ts` for the twin fact about Shift and Escape.
 */
import { requireOptionalNativeModule } from 'expo'

import { normaliseDroppedFiles, type DroppedFile } from './file-drop.shared'

export type { DroppedFile } from './file-drop.shared'

type PasteboardModule = {
  readPasteboardAttachment?: () => Promise<unknown>
}

function nativeModule(): PasteboardModule | null {
  try {
    return requireOptionalNativeModule<PasteboardModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

/** Whether this build can answer what is on the general pasteboard. */
export const HAS_NATIVE_PASTEBOARD = typeof mac?.readPasteboardAttachment === 'function'

/**
 * Every image or file on the general pasteboard, or an empty list.
 *
 * Never throws: a pasteboard this process could not read is the same thing to a
 * reader who just pressed ⌘V as an empty one, and the composer's own text field
 * has already taken whatever plain text there was regardless of what this
 * answers.
 */
export async function readPasteboardAttachment(): Promise<DroppedFile[]> {
  try {
    const payload = await mac?.readPasteboardAttachment?.()

    return normaliseDroppedFiles(payload)
  } catch {
    return []
  }
}
