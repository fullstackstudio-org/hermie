/**
 * A drawn `hermie-chart` or `hermie-cards` block: the picture itself, with no header bar over it.
 *
 * What a listing has (a language label, Copy, Show source) lives in a small "..." button in the block's top-right corner
 * instead, so the picture is the block. The button is quiet: invisible until the pointer is over the block or focus is in
 * it, always faintly there where there is no hover (a touch screen), and a real button either way (reachable by Tab,
 * named, announcing whether it is open). It opens a short panel with "Show source" (a toggle: pressed, the JSON is shown
 * in the picture's place) and "Copy source". Escape closes the panel and returns to the button; so does moving on.
 *
 * The result of a copy is said in a polite live region beside the button, as the code block does, and a copy the browser
 * refuses says so.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { sheetStrings } from '../i18n/sheet-strings'
import { useLocale } from '../i18n/use-locale'
import { writeClipboard } from '../platform/clipboard'

export interface DrawnBlockProps {
  /** The block's source: what Copy copies and what Show source shows. */
  code: string
  /** What the block is. */
  kind: 'chart' | 'cards'
  /** The picture. */
  drawing: ReactNode
}

/** How long the confirmation stays. */
const STATUS_MS = 2000

type CopyState = 'idle' | 'copied' | 'failed'

export function DrawnBlock({ code, kind, drawing }: DrawnBlockProps) {
  useLocale()

  const [open, setOpen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [state, setState] = useState<CopyState>('idle')
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const panel = useId()

  useEffect(() => () => clearTimeout(timer.current), [])

  // A press anywhere else closes the panel.
  useEffect(() => {
    if (!open) {
      return undefined
    }

    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', away)

    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const copy = (): void => {
    setOpen(false)
    button.current?.focus()
    void writeClipboard(code).then(ok => {
      setState(ok ? 'copied' : 'failed')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), STATUS_MS)
    })
  }

  const message =
    state === 'copied' ? sheetStrings.markdown.copied : state === 'failed' ? sheetStrings.markdown.copyFailed : ''

  return (
    <div
      className="md-block"
      data-drawn={String(!showSource)}
      data-kind={kind}
      onBlur={event => {
        // Focus left the block altogether.
        if (open && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          button.current?.focus()
        }
      }}
      ref={root}
    >
      <div className="md-block-menu">
        <span aria-live="polite" className="md-block-status" role="status">
          {message}
        </span>
        <button
          aria-controls={panel}
          aria-expanded={open}
          aria-label={sheetStrings.markdown.moreOptions}
          className="md-block-more"
          onClick={() => setOpen(value => !value)}
          ref={button}
          type="button"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            <path d="M5 12h.01M12 12h.01M19 12h.01" />
          </svg>
        </button>
        <div className="md-block-panel" hidden={!open} id={panel}>
          <button
            aria-pressed={showSource}
            className="md-block-action"
            onClick={() => {
              setShowSource(value => !value)
              setOpen(false)
              button.current?.focus()
            }}
            type="button"
          >
            {sheetStrings.markdown.showSource}
          </button>
          <button className="md-block-action" onClick={copy} type="button">
            {sheetStrings.markdown.copySource}
          </button>
        </div>
      </div>
      {showSource ? (
        <pre className="md-block-source" tabIndex={0}>
          <code>{code}</code>
        </pre>
      ) : (
        <div className="md-block-drawing">{drawing}</div>
      )}
    </div>
  )
}
