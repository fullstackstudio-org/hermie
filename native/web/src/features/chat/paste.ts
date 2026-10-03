/**
 * Which files a paste into the composer carries, if it should attach any.
 *
 * A clipboard often holds the same thing in several shapes, and the rule is
 * about which one the reader meant:
 *
 *  - **Files and no text**: a screenshot, an image copied out of a viewer or a
 *    page. Attach them.
 *  - **Files whose text is only their names**: a file copied in the Finder or the
 *    Explorer, where the browser adds the name as text. Attach them; the names
 *    would be the wrong thing to type into the field.
 *  - **Files beside other text**: cells copied out of a spreadsheet, a passage
 *    out of a word processor, which put a picture of what was copied next to its
 *    text. The text is what was meant: nothing is attached and the paste goes
 *    into the field as the browser would do it anyway.
 *
 * Only `kind === 'file'` items count, so a clipboard of plain text never reaches
 * the tray.
 */

/** The files to attach from a paste, in clipboard order, or an empty list for a paste that is text. */
export function filesFromPaste(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }

  const files: File[] = []

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') {
      continue
    }

    const file = item.getAsFile()

    if (file) {
      files.push(file)
    }
  }

  // Some engines list the files on `files` and not on `items`.
  if (files.length === 0) {
    files.push(...Array.from(data.files ?? []))
  }

  if (files.length === 0) {
    return []
  }

  const text = data.getData('text/plain').trim()

  if (text === '') {
    return files
  }

  const names = new Set(files.map(file => file.name))
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
  const onlyNames = lines.every(line => names.has(line) || names.has(line.split(/[/\\]/u).pop() ?? ''))

  return onlyNames ? files : []
}
