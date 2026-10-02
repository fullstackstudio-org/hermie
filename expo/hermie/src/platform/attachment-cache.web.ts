/**
 * There is no caches directory in a browser, and nothing to preview into.
 *
 * `quick-look.web.ts` already answers `false` for everything, so a browser
 * never reaches a previewer — a tap on an attachment there is a download, which
 * is what `share-file.web.ts` performs. Fetching the bytes into memory first
 * would buy nothing and would mean holding somebody's attachment in a tab.
 */
export function previewFileName(name: string): string {
  return name
}

export async function cacheRemoteAttachment(): Promise<string | null> {
  return null
}
