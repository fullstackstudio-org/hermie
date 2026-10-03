/**
 * A fenced code block: the language, a copy button and the source in a
 * monospace box that scrolls sideways.
 *
 * With a language, the source is coloured once the highlighting chunk has
 * loaded (`Highlight.tsx`, through `lazy.ts`); until then, and for a language
 * no grammar knows, it is the plain source, which has the same characters and
 * so the same size.
 *
 * The same box carries a drawing (`drawing`): typeset mathematics and Mermaid
 * diagrams are shown in it, with a "Show source" toggle that puts the source in
 * their place. The drawing's own text alternative is the source too (the
 * renderer that makes it sets that); the toggle is for the eye and for copying a
 * part of it. The copy button always copies the source.
 *
 * The copy button confirms in a polite live region next to it, so the result is
 * heard as well as seen, and does not take focus. A copy the browser refuses (no
 * secure context, no permission) says so instead of staying silent.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useLocale } from '../i18n/use-locale'
import { webStrings } from '../i18n/web-strings'
import { writeClipboard } from '../platform/clipboard'
import { highlightRenderer, useLazyModule } from './lazy'

export type CodeBlockKind = 'code' | 'math' | 'mermaid'

export interface CodeBlockProps {
  code: string
  /** The first word of the fence's info string. */
  language?: string
  /** What the block holds. */
  kind?: CodeBlockKind
  /** The label in the corner when it is not the language (a `math` block is LaTeX). */
  label?: string
  /**
   * The source drawn (an `svg`): shown instead of the source, with a toggle back
   * to it. Without it the block is the source.
   */
  drawing?: ReactNode
}

/** How long the confirmation stays. */
const STATUS_MS = 2000

/** A language is data from the message; it becomes a class name only when it is a plain token. */
const SAFE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,40}$/

type CopyState = 'idle' | 'copied' | 'failed'

/** Stands in for the highlighting chunk where there is nothing to colour: never loads. */
const NO_HIGHLIGHT: typeof highlightRenderer = {
  current: () => undefined,
  load: () => new Promise(() => undefined),
  subscribe: () => () => undefined
}

/** The source, coloured when the chunk is there and the language is one it knows. */
function SourceText({ code, language }: { code: string; language: string | undefined }) {
  // Asked for only when there is a language to colour: a plain fence never loads it.
  const highlight = useLazyModule(language ? highlightRenderer : NO_HIGHLIGHT)

  if (!language || !highlight || !highlight.isKnownLanguage(language)) {
    return <>{code}</>
  }

  return <highlight.HighlightedCode code={code} language={language} />
}

export function CodeBlock({ code, language, kind = 'code', label, drawing }: CodeBlockProps) {
  useLocale()

  const [state, setState] = useState<CopyState>('idle')
  const [showSource, setShowSource] = useState(false)
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
  const drawn = drawing !== undefined && !showSource

  return (
    <div className="md-code" data-kind={kind} {...(drawing !== undefined ? { 'data-drawn': String(drawn) } : {})}>
      <div className="md-code-bar">
        {shown ? <span className="md-code-lang">{shown}</span> : null}
        {drawing !== undefined ? (
          <button
            aria-pressed={showSource}
            className="md-code-toggle"
            onClick={() => setShowSource(value => !value)}
            type="button"
          >
            {webStrings.markdown.showSource}
          </button>
        ) : null}
        <button className="md-code-copy" onClick={copy} type="button">
          {webStrings.markdown.copyCode}
        </button>
        <span aria-live="polite" className="md-code-status" role="status">
          {message}
        </span>
      </div>
      {drawn ? (
        <div className="md-drawing" tabIndex={0}>
          {drawing}
        </div>
      ) : (
        <pre className="md-code-body" tabIndex={0}>
          <code {...(language && SAFE_LANGUAGE.test(language) ? { className: `language-${language}` } : {})}>
            <SourceText code={code} language={kind === 'code' ? language : undefined} />
          </code>
        </pre>
      )}
    </div>
  )
}
