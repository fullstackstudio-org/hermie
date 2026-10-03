/**
 * A fenced code block: the language, a copy button and the source in a
 * monospace box that scrolls sideways.
 *
 * No colours yet. Highlighting, LaTeX and Mermaid arrive with W-21; until then
 * a `math` or `mermaid` block is shown here as its source, which is also what
 * those renderers fall back to for source they cannot draw.
 *
 * The copy button confirms in a polite live region next to it, so the result is
 * heard as well as seen, and does not take focus. A copy the browser refuses (no
 * secure context, no permission) says so instead of staying silent.
 */
import { useEffect, useRef, useState } from 'react'

import { useLocale } from '../i18n/use-locale'
import { webStrings } from '../i18n/web-strings'
import { writeClipboard } from '../platform/clipboard'

export type CodeBlockKind = 'code' | 'math' | 'mermaid'

export interface CodeBlockProps {
  code: string
  /** The first word of the fence's info string. */
  language?: string
  /** What the block holds; the renderers that replace the source key off it. */
  kind?: CodeBlockKind
  /** The label in the corner when it is not the language (a `math` block is LaTeX). */
  label?: string
}

/** How long the confirmation stays. */
const STATUS_MS = 2000

/** A language is data from the message; it becomes a class name only when it is a plain token. */
const SAFE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,40}$/

type CopyState = 'idle' | 'copied' | 'failed'

export function CodeBlock({ code, language, kind = 'code', label }: CodeBlockProps) {
  useLocale()

  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = (): void => {
    void writeClipboard(code).then(ok => {
      setState(ok ? 'copied' : 'failed')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), STATUS_MS)
    })
  }

  const shown = label ?? language
  const message =
    state === 'copied' ? webStrings.markdown.copied : state === 'failed' ? webStrings.markdown.copyFailed : ''

  return (
    <div className="md-code" data-kind={kind}>
      <div className="md-code-bar">
        {shown ? <span className="md-code-lang">{shown}</span> : null}
        <button className="md-code-copy" onClick={copy} type="button">
          {webStrings.markdown.copyCode}
        </button>
        <span aria-live="polite" className="md-code-status" role="status">
          {message}
        </span>
      </div>
      <pre className="md-code-body" tabIndex={0}>
        <code {...(language && SAFE_LANGUAGE.test(language) ? { className: `language-${language}` } : {})}>{code}</code>
      </pre>
    </div>
  )
}
