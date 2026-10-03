/**
 * Coloured code, from the spans `@hermie/markdown`'s `highlight.ts` makes.
 *
 * A lazy chunk (`lazy.ts`): highlight.js core and its fifteen grammars are not
 * part of the first screen. highlight.js only speaks HTML, and the package
 * already parses its output back into `{ text, scope }` spans; here each span
 * becomes a `span` with a class, and nothing from highlight.js reaches the DOM as
 * markup. The text of every span is a React text child.
 *
 * The colours are custom properties (`markdown-highlight.css`), one per scope
 * and scheme, with the values of the package's `code-theme.ts`; a test holds the
 * two together and measures every one against the code block's surface.
 */
import { highlightToLines, isKnownLanguage, type CodeSpan } from '@hermie/markdown/highlight'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export { isKnownLanguage }

/**
 * Every scope `code-theme.ts` has a colour for. A span whose scope is not here
 * (or whose first segment is not, for a dotted scope) is drawn in the block's
 * own text colour, exactly as `codeScopeColor` answers `undefined` for it.
 */
export const HIGHLIGHT_SCOPES: readonly string[] = [
  'addition',
  'attr',
  'attribute',
  'built_in',
  'bullet',
  'char',
  'class',
  'code',
  'comment',
  'deletion',
  'doctag',
  'emphasis',
  'formula',
  'function',
  'keyword',
  'link',
  'literal',
  'meta',
  'name',
  'number',
  'operator',
  'params',
  'property',
  'punctuation',
  'quote',
  'regexp',
  'section',
  'selector-tag',
  'strong',
  'string',
  'subst',
  'symbol',
  'tag',
  'title',
  'type',
  'variable'
]

const KNOWN = new Set(HIGHLIGHT_SCOPES)

/** The class a scope is drawn with, or `undefined` for the block's own colour. */
export function scopeClass(scope: string | undefined): string | undefined {
  if (!scope) {
    return undefined
  }

  const key = KNOWN.has(scope) ? scope : scope.split('.')[0]

  // `built_in` is spelled with a hyphen in the class, like every other class here.
  return key && KNOWN.has(key) ? `md-hl md-hl-${key.replaceAll('_', '-')}` : undefined
}

function Span({ span }: { span: CodeSpan }) {
  const className = scopeClass(span.scope)

  return className ? <span className={className}>{span.text}</span> : <>{span.text}</>
}

export interface HighlightedCodeProps {
  code: string
  language: string
}

/** How many highlighted listings are remembered; the oldest is forgotten first. */
export const HIGHLIGHT_CACHE_SIZE = 500

/** A listing longer than this is highlighted but not remembered, so the cache stays small. */
const CACHEABLE_LENGTH = 20_000

const cache = new Map<string, CodeSpan[][]>()

/**
 * The lines of `code` in `language`, remembered by both: a block that mounts
 * again (a history page landing above it, a chat opened a second time) gets
 * the spans it had without highlight.js running again.
 */
export function cachedLines(code: string, language: string): CodeSpan[][] {
  if (code.length > CACHEABLE_LENGTH) {
    return highlightToLines(code, language)
  }

  const key = `${language}\n${code}`
  const hit = cache.get(key)

  if (hit) {
    // Most recently used goes last: a Map iterates in insertion order.
    cache.delete(key)
    cache.set(key, hit)

    return hit
  }

  const lines = highlightToLines(code, language)

  cache.set(key, lines)

  if (cache.size > HIGHLIGHT_CACHE_SIZE) {
    cache.delete(cache.keys().next().value as string)
  }

  return lines
}

/** Empties the cache (tests). */
export function clearHighlightCache(): void {
  cache.clear()
}

/**
 * While a listing grows (a reply streaming into it), it is coloured again at
 * most this often; between two passes the part that arrived since is drawn
 * plain after the coloured part. Same characters, same size: only the colour of
 * the newest few characters waits.
 */
export const STREAM_HIGHLIGHT_MS = 150

function Lines({ lines }: { lines: CodeSpan[][] }) {
  return (
    <>
      {lines.map((spans, index) => (
        <Fragment key={index}>
          {index > 0 ? '\n' : null}
          {spans.map((span, at) => (
            <Span key={at} span={span} />
          ))}
        </Fragment>
      ))}
    </>
  )
}

/**
 * The lines of `code`, coloured. The text is exactly `code`: the spans of a line
 * are its characters in order, and the lines are joined with the newlines they
 * were split on, so selecting and copying out of the block gives the source back.
 */
function HighlightedCodeView({ code, language }: HighlightedCodeProps) {
  // The text that was last coloured; it catches up with `code` at most every STREAM_HIGHLIGHT_MS.
  const [coloured, setColoured] = useState(code)
  const latest = useRef(code)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useLayoutEffect(() => {
    latest.current = code
  }, [code])

  useEffect(() => {
    if (code === coloured || pending.current !== undefined) {
      return
    }

    pending.current = setTimeout(() => {
      pending.current = undefined
      setColoured(latest.current)
    }, STREAM_HIGHLIGHT_MS)
  }, [code, coloured])

  useEffect(() => () => clearTimeout(pending.current), [])

  // A listing that grew keeps its coloured part and shows the new tail plain; any
  // other change (rare: an edit in the middle) is plain until the next pass.
  const base = code === coloured || code.startsWith(coloured) ? coloured : ''
  const lines = useMemo(() => (base ? cachedLines(base, language) : []), [base, language])

  return (
    <>
      <Lines lines={lines} />
      {code.slice(base.length)}
    </>
  )
}

export const HighlightedCode = memo(HighlightedCodeView)
