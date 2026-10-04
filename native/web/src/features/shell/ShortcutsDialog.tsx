/**
 * The list of keyboard shortcuts: a modal dialog over the page, drawn from the same table the page's listener
 * answers to (`platform/shortcuts.ts`), so it promises exactly what works.
 *
 * What a dialog owes a keyboard and a screen reader, as the image viewer does: `role="dialog"` and `aria-modal`, named
 * by its heading; everything behind it `inert` while it is open (`isolateModal`); the focus moves to Close when it
 * opens, Tab stays inside it and the focus goes back to what had it when it closes; Escape and a press on the backdrop
 * close it. Nothing here answers anything, so leaving is always safe.
 *
 * The table is a table: a caption-less `<table>` named by the dialog, one row for each action, its keys in `<kbd>`
 * elements ("Cmd+K or Ctrl+K" is how a key combination is read, not two). On a Mac the combinations are drawn with
 * the Mac's symbols, elsewhere with words, as the person's own keyboard says them.
 *
 * A chunk of its own, fetched the first time the list is asked for (`features/shell/load-shortcuts.ts`).
 */
import { type KeyboardEvent, type ReactElement, useEffect, useId, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'

import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { isolateModal } from '../../platform/modal-isolation'
import { type Chord, isApplePlatform, SHORTCUTS } from '../../platform/shortcuts'
import './shortcuts.css'

export interface ShortcutsDialogProps {
  onClose: () => void
  /** Where the focus goes back to when the list closes. */
  opener?: HTMLElement | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

const NAMED_KEYS: Readonly<Record<string, string>> = { ArrowUp: '↑', ArrowDown: '↓' }

/** A key combination as the person's keyboard says it: `⌘K` on a Mac, `Ctrl+K` elsewhere. */
export function chordLabel(chord: Chord, apple: boolean): string {
  const key =
    chord.key === 'Digit'
      ? '1–9'
      : (NAMED_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key))
  const parts = [
    ...(chord.ctrl ? [apple ? '⌃' : 'Ctrl'] : []),
    ...(chord.mod ? [apple ? '⌘' : 'Ctrl'] : []),
    ...(chord.alt ? [apple ? '⌥' : 'Alt'] : []),
    // A question mark carries its Shift in the character; the chord only says "whatever the layout needs".
    ...(chord.shift === true ? [apple ? '⇧' : 'Shift'] : []),
    key
  ]

  return apple ? parts.join('') : parts.join('+')
}

export function ShortcutsDialog({ onClose, opener }: ShortcutsDialogProps): ReactElement {
  useLocale()

  const titleId = useId()
  const leadId = useId()
  const overlay = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const apple = useMemo(isApplePlatform, [])
  const words = sheetStrings.shortcuts

  useEffect(() => {
    if (!overlay.current) {
      return undefined
    }

    const undo = isolateModal(overlay.current)

    close.current?.focus()

    return () => {
      undo()

      if (opener?.isConnected) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [opener])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()

      return
    }

    if (event.key !== 'Tab' || !dialog.current) {
      return
    }

    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (!first || !last) {
      return
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="hm-shortcuts"
      ref={overlay}
      onKeyDown={onKeyDown}
      onClick={event => {
        // The backdrop, not the dialog.
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        className="hm-shortcuts__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        ref={dialog}
      >
        <div className="hm-shortcuts__bar">
          <h2 className="hm-shortcuts__title" id={titleId}>
            {words.title}
          </h2>
          <button type="button" className="hm-shortcuts__close" ref={close} onClick={onClose}>
            {strings.app.common.done}
          </button>
        </div>
        <p className="hm-shortcuts__lead" id={leadId}>
          {words.lead}
        </p>
        <table className="hm-shortcuts__table">
          <thead>
            <tr>
              <th scope="col">{words.actionColumn}</th>
              <th scope="col">{words.keysColumn}</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(shortcut => (
              <tr key={shortcut.action}>
                <th scope="row">{words.action[shortcut.action]}</th>
                <td>
                  {shortcut.chords.map((chord, index) => (
                    <span className="hm-shortcuts__chord" key={`${chord.key}:${index}`}>
                      {index > 0 ? <span className="hm-shortcuts__or">{words.or}</span> : null}
                      <kbd>{chordLabel(chord, apple)}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hm-shortcuts__note">{words.newNote}</p>
        <p className="hm-shortcuts__note">{words.browserNote}</p>
      </div>
    </div>,
    document.body
  )
}
