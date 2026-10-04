/**
 * Opening a link the person pressed, in a tab of its own.
 *
 * `noopener` and `noreferrer`: the page it opens gets no `window.opener` to reach
 * back into this one through, and no `Referer` saying where it was opened from
 * (this page's path names the gateway). Nothing here checks the link: the caller
 * passes only one it has already checked (`core/connections.ts`,
 * `authorisationLink`), and calls this only from a press.
 */
export function openInNewTab(url: string, open: typeof window.open = (...args) => window.open(...args)): void {
  open(url, '_blank', 'noopener,noreferrer')
}

/**
 * A blank tab, opened in the press itself (the only moment a popup blocker lets one through) to be sent somewhere once
 * that is known: a PDF the page fetched (`core/chats/outbox-files.ts`). `null` when the browser refused.
 */
export function openBlankTab(open: typeof window.open = (...args) => window.open(...args)): Window | null {
  return open('', '_blank')
}
