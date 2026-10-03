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
import { Fragment, memo, useMemo } from 'react'

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

/**
 * The lines of `code`, coloured. The text is exactly `code`: the spans of a line
 * are its characters in order, and the lines are joined with the newlines they
 * were split on, so selecting and copying out of the block gives the source back.
 */
function HighlightedCodeView({ code, language }: HighlightedCodeProps) {
  const lines = useMemo(() => highlightToLines(code, language), [code, language])

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

export const HighlightedCode = memo(HighlightedCodeView)
