/**
 * The browser half of `composer-paste.ts`. Read that file first.
 *
 * A `paste` event on the field's own DOM node, bound the same way
 * `file-drop.web.tsx` binds `drop` — the ref React Native Web hands back off a
 * `TextInput` IS the node, so the listener goes there rather than on a prop the
 * platform does not forward (RNW's `TextInput` has no `onPaste` prop at all).
 *
 * ## Both `.files` and `.items`
 *
 * `clipboardData.files` is enough in most browsers, but Safari has historically
 * left it empty for a pasted screenshot and put the same `File` only in
 * `clipboardData.items` — a `DataTransferItem` whose `kind` is `'file'`. Reading
 * both and de-duplicating by the `File` object itself is what makes a paste that
 * only one of the two lists is honest about still arrive as an attachment.
 *
 * ## `preventDefault` is conditional, and that is the whole feature
 *
 * It runs only once a file was actually taken. A plain-text paste has no
 * `clipboardData.files` and no file-kind item, so the browser's own paste
 * proceeds untouched — the words land in the field exactly as they always have,
 * because nothing here ever looks at them.
 */
import type { DroppedFile } from './file-drop.shared'

export type { DroppedFile } from './file-drop.shared'

const FALLBACK_MIME_TYPE = 'application/octet-stream'

/** One `File`, in the shape the rest of the app already speaks. */
function droppedFileOf(file: File): DroppedFile {
  return {
    body: file,
    mimeType: file.type || FALLBACK_MIME_TYPE,
    name: file.name || 'attachment',
    size: Number.isFinite(file.size) ? file.size : 0,
    uri: URL.createObjectURL(file)
  }
}

/**
 * Every file a paste's clipboard is carrying, from `.files` and any file-kind
 * `.items` neither has already produced.
 */
export function filesFromClipboard(data: DataTransfer | null | undefined): DroppedFile[] {
  if (!data) {
    return []
  }

  const seen = new Set<File>()
  const files: DroppedFile[] = []

  const take = (file: File | null | undefined) => {
    if (file && !seen.has(file)) {
      seen.add(file)
      files.push(droppedFileOf(file))
    }
  }

  const list = data.files

  for (let index = 0; index < (list?.length ?? 0); index += 1) {
    take(list?.item(index))
  }

  const items = data.items

  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items[index]

    if (item?.kind === 'file') {
      take(item.getAsFile())
    }
  }

  return files
}

export function attachPasteListener(node: unknown, onFiles: (files: DroppedFile[]) => void): () => void {
  const element = node as { addEventListener?: unknown; removeEventListener?: unknown } | null

  if (!element || typeof element.addEventListener !== 'function' || typeof element.removeEventListener !== 'function') {
    return () => undefined
  }

  const target = element as unknown as EventTarget

  const onPaste = (event: Event) => {
    const files = filesFromClipboard((event as ClipboardEvent).clipboardData)

    if (!files.length) {
      // No file on the clipboard — a plain-text paste, left for the field itself.
      return
    }

    event.preventDefault()
    onFiles(files)
  }

  target.addEventListener('paste', onPaste)

  return () => target.removeEventListener('paste', onPaste)
}
