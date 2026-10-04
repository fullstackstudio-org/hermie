/**
 * How a prompt names the files that were put on the gateway for it (`file-upload.ts` puts them there).
 *
 * Apart from the upload because a send reads them and the upload is only what the composer and the file sheet do: the
 * chat controller's `send` is in the first load and imports this, and the upload comes with the pages that use it.
 */
/**
 * The token the gateway expands into the file's contents.
 *
 * Backticks because a path with a space in it otherwise ends at the space —
 * `agent/context_references.py` strips exactly this pair of wrappers back off.
 */
export function fileReferenceFor(path: string): string {
  return /\s/.test(path) ? `@file:\`${path}\`` : `@file:${path}`
}

/**
 * An attached image's reference, with only the name in the path position.
 *
 * Nothing puts this in the prompt: `image.attach_bytes` carries the bytes and the
 * gateway writes its own `@image:<path>` into the row it persists. This is what
 * the bubble records until that row lands, so the two can still be recognised as
 * one send — `attachmentsMatchKey` compares the name, which is all a client was
 * ever told. Same wrapping rule as a file, for a name with a space in it.
 */
export function imageReferenceFor(name: string): string {
  return /\s/.test(name) ? `@image:\`${name}\`` : `@image:${name}`
}

/** The prompt as it goes to the gateway: the user's words, then the references. */
export function withFileReferences(text: string, paths: readonly string[]): string {
  if (!paths.length) {
    return text
  }

  const references = paths.map(fileReferenceFor).join('\n')
  const body = text.trim()

  return body ? `${body}\n\n${references}` : references
}
