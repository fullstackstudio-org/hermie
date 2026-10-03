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
