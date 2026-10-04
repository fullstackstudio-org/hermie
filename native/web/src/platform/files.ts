/**
 * The browser's files, for the composer's attachments: reading an image's bytes,
 * the files a drag carries, and keeping a stray drop from opening a file in
 * place of the app.
 *
 * Nothing here decides anything about an attachment (that is
 * `core/chats/attachments.ts`); these are the browser calls it needs, behind one
 * seam.
 */

/**
 * A blob's bytes as plain base64, without the `data:<type>;base64,` prefix that
 * `FileReader` puts in front (`image.attach_bytes` takes either; the Expo app
 * sends it bare, so this does too).
 */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')

      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}

/** Whether a drag carries files (rather than text or a link from the page). */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types).includes('Files'))
}

/** The files of a drop, in order. */
export function filesOf(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : []
}

/**
 * While a chat that can take attachments is open, a file dropped anywhere else
 * on the page is ignored rather than opened by the browser in place of the app
 * (which would leave the conversation, and the draft with it). Answers the undo.
 */
export function guardStrayFileDrops(target: Document = document): () => void {
  const refuse = (event: DragEvent): void => {
    // The drop zone already took it (and chose its own drop effect); this is only for everywhere else.
    if (event.defaultPrevented) {
      return
    }

    if (dragCarriesFiles(event.dataTransfer)) {
      event.preventDefault()

      if (event.type === 'dragover' && event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none'
      }
    }
  }

  target.addEventListener('dragover', refuse)
  target.addEventListener('drop', refuse)

  return () => {
    target.removeEventListener('dragover', refuse)
    target.removeEventListener('drop', refuse)
  }
}

/** How long the object URL of a saved file lives: long enough for every browser to have started the save. */
const REVOKE_AFTER_MS = 30_000

/**
 * The name a download is offered under: the last segment, without what a file system would refuse, and without the
 * control and format characters (`\p{Cc}`, `\p{Cf}`: a right-to-left override, a zero-width joiner) the name on the
 * card is shown without (`displayText`), so the saved name is the one the reader saw.
 */
export function downloadNameOf(name: string): string {
  const base = (name.split(/[/\\]/u).pop() ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>:"|?*]/gu, '_')
    .trim()

  return base || 'file'
}

/** Hand a blob to the browser as a download, under `name`. Throws when the browser cannot make one. */
export function saveBlob(blob: Blob, name: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob)
  const link = doc.createElement('a')

  link.href = url
  link.download = downloadNameOf(name)
  link.rel = 'noopener'
  link.hidden = true
  // In the document, because some browsers ignore a click on a link that is not.
  doc.body.append(link)

  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
  }
}

/**
 * Call `onEnd` when a drag over the page ends in a way a drop zone may not hear: a drop or dragend anywhere on the
 * page (caught on the way down, so a child that stops it still counts), or no dragover for `staleMs` (Esc, or the
 * pointer left the window, where Safari sends no balancing dragleave). Returns the function that stops listening.
 */
export function watchDragEnd(onEnd: () => void, staleMs: number, target: Window = window): () => void {
  let timer = target.setTimeout(onEnd, staleMs)
  const rearm = (): void => {
    target.clearTimeout(timer)
    timer = target.setTimeout(onEnd, staleMs)
  }

  target.addEventListener('dragover', rearm, true)
  target.addEventListener('drop', onEnd, true)
  target.addEventListener('dragend', onEnd, true)

  return () => {
    target.clearTimeout(timer)
    target.removeEventListener('dragover', rearm, true)
    target.removeEventListener('drop', onEnd, true)
    target.removeEventListener('dragend', onEnd, true)
  }
}
