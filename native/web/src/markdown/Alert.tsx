/**
 * A GitHub-style alert in a message: a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
 * `[!WARNING]` or `[!CAUTION]`, drawn as a callout (`contract/markup/README.md` section 4).
 *
 * Not a block of its own: the parser still produces a quote, so the shared block model is untouched and every other
 * renderer shows a quote that begins with the marker. Here the marker line becomes the callout's title (an icon, a tint,
 * the kind in words) and the rest of the quote is its content. It is an `aside` named by its kind, so a screen reader
 * announces "Warning, note" before the words; the icon is decoration and says nothing.
 *
 * In the entry's graph on purpose: it is a few lines of markup and no code, and a callout that arrived after the text
 * would change the height of a row that was already on the page.
 */
import { marked, type Token, type Tokens } from '@hermie/markdown/marked-compat'
import { createContext, useContext, type ReactNode } from 'react'

import { useLocale } from '../i18n/use-locale'
import { sheetStrings } from '../i18n/sheet-strings'

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

/** The five markers, upper case and exact, alone on their line (white space after it is allowed). */
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/u

/** Set inside a callout: a quote in it is an ordinary quote. */
export const InAlertContext = createContext(false)

/** The kind a quote's first paragraph says, and the tokens that are left once its marker line is gone. */
export function readAlert(quote: Tokens.Blockquote): { kind: AlertKind; body: Token[] } | undefined {
  const first = quote.tokens[0]

  if (first?.type !== 'paragraph') {
    return undefined
  }

  const text = (first as Tokens.Paragraph).text
  const match = MARKER.exec(text)

  if (!match) {
    return undefined
  }

  const rest = text.slice(match[0].length)
  const body = [...(rest.trim() ? marked.lexer(rest) : []), ...quote.tokens.slice(1)]

  return { kind: (match[1] as string).toLowerCase() as AlertKind, body }
}

/** The outline of each kind's icon, on a 24x24 grid (stroke `currentColor`, no fill). */
const ICON_PATH: Record<AlertKind, string> = {
  note: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  tip: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  important: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM12 8v3M12 13.2h.01',
  warning: 'M12 4L3 19.5h18zM12 10v4.5M12 17.2h.01',
  caution: 'M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7zM12 8v5M12 16h.01'
}

export function Alert({ kind, children }: { kind: AlertKind; children: ReactNode }) {
  useLocale()

  const name = sheetStrings.markdown.alert[kind]

  return (
    <aside aria-label={name} className="md-alert" data-kind={kind} role="note">
      <div className="md-alert-title">
        <svg aria-hidden="true" className="md-alert-icon" focusable="false" viewBox="0 0 24 24">
          <path d={ICON_PATH[kind]} />
        </svg>
        <span aria-hidden="true">{name}</span>
      </div>
      <InAlertContext.Provider value>
        <div className="md-alert-body">{children}</div>
      </InAlertContext.Provider>
    </aside>
  )
}

/** Whether we are inside a callout. */
export const useInAlert = (): boolean => useContext(InAlertContext)
