/**
 * The pages a reply used, in a modal dialog (`contract/sources/`).
 *
 * What a dialog owes a keyboard and a screen reader, as the shortcuts list and the image viewer do: `role="dialog"` and
 * `aria-modal`, named by its heading; everything behind it `inert` while it is open (`isolateModal`); the focus moves to
 * Done when it opens, Tab stays inside it and the focus goes back to the pill when it closes; Escape and a press on the
 * backdrop close it.
 *
 * The list is two sections, "Read" (pages the bot fetched) and "Found" (search results it may not have opened), each a
 * list of links. A row is the monogram, the title and the HOST, written out whole: a title is whatever the page called
 * itself, so the host beside it is what tells the person where the link goes. A row without a title shows the host as
 * its title. A link opens in a new tab with `rel="noopener noreferrer"` (the same policy as a link in a reply) and only
 * on the person's own press; an address the link policy refuses is shown as text and not followed.
 *
 * Titles are text, cleaned once more here (`displayText`): control, format and bidi characters are dropped and a title
 * of marks stacked on a letter is cut, so a title cannot paint over its neighbours or reorder the host next to it.
 */
import type { Source } from '@hermie/transcript'
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

import { strings } from '../../../generated/strings'
import { sheetStrings } from '../../../i18n/sheet-strings'
import { useLocale } from '../../../i18n/use-locale'
import { displayText } from '../../../core/requests/secure-input'
import { LINK_REL, LINK_TARGET } from '../../../markdown/links'
import { isolateModal } from '../../../platform/modal-isolation'
import { VisuallyHidden } from '../../../ui/primitives/VisuallyHidden'
import { Monogram } from './Monogram'
import { type SourceRow, tiersOf } from './sources-model'
import './sources.css'

export interface SourcesDialogProps {
  sources: readonly Source[]
  onClose: () => void
  /** Where the focus goes back to when the dialog closes. */
  opener?: HTMLElement | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Longest title shown, in characters; the contract allows 160. */
const TITLE_LIMIT = 160

function Row({ row }: { row: SourceRow }): ReactElement {
  const title = displayText(row.source.title, TITLE_LIMIT)
  const words = sheetStrings.sources

  const body = (
    <>
      <Monogram url={row.source.url} />
      <span className="hm-source__text">
        <span className="hm-source__title">{title || row.host}</span>
        {title ? <span className="hm-source__host">{row.host}</span> : null}
        {row.href ? null : <span className="hm-source__host">{words.notLinked}</span>}
      </span>
    </>
  )

  if (!row.href) {
    return <li className="hm-source hm-source--text">{body}</li>
  }

  return (
    <li className="hm-source">
      <a className="hm-source__link" href={row.href} target={LINK_TARGET} rel={LINK_REL}>
        {body}
        <span className="hm-source__arrow" aria-hidden="true">
          ↗
        </span>
        <VisuallyHidden> ({words.newTab})</VisuallyHidden>
      </a>
    </li>
  )
}

export function SourcesDialog({ sources, onClose, opener }: SourcesDialogProps): ReactElement {
  useLocale()

  const titleId = useId()
  const leadId = useId()
  const overlay = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const words = sheetStrings.sources
  const tiers = tiersOf(sources)

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
      className="hm-sources-overlay"
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
        className="hm-sources-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        ref={dialog}
      >
        <div className="hm-sources-dialog__bar">
          <h2 className="hm-sources-dialog__title" id={titleId}>
            {words.title}
          </h2>
          <button type="button" className="hm-sources-dialog__close" ref={close} onClick={onClose}>
            {strings.app.common.done}
          </button>
        </div>
        <p className="hm-sources-dialog__lead" id={leadId}>
          {words.lead}
        </p>
        {tiers.map(tier => (
          <TierSection key={tier.via} via={tier.via} rows={tier.rows} />
        ))}
      </div>
    </div>,
    document.body
  )
}

function TierSection({ via, rows }: { via: Source['via']; rows: SourceRow[] }): ReactElement {
  const headingId = useId()
  const heading = via === 'read' ? sheetStrings.sources.read : sheetStrings.sources.found

  return (
    <section className="hm-sources-dialog__section" aria-labelledby={headingId}>
      <h3 className="hm-sources-dialog__heading" id={headingId}>
        {heading}
      </h3>
      <ul className="hm-sources-dialog__list">
        {rows.map(row => (
          <Row key={row.source.url} row={row} />
        ))}
      </ul>
    </section>
  )
}
