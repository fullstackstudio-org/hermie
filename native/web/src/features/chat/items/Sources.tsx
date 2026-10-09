/**
 * The "Sources" pill under a reply that used pages (`contract/sources/`), and the dialog it opens.
 *
 * The pill is a button: the word, the count, and up to three monograms overlapping at its start. A monogram is the
 * first letter of a host on a colour taken from a hash of it, drawn by CSS: no favicon, no preview, no request of any
 * kind, because an icon fetched for a page the person has not opened would tell that site (or a service) what they
 * are reading. The monograms are decoration (`aria-hidden`); the button's name is its words and its count.
 *
 * A reply with no sources has no pill, and neither has a note the bot wrote on the way to its answer.
 */
import type { Source } from '@hermie/transcript'
import { memo, useCallback, useMemo, useRef, useState } from 'react'

import { formatNumber } from '../../../i18n/format'
import { sheetStrings } from '../../../i18n/sheet-strings'
import { useLocale } from '../../../i18n/use-locale'
import { Monogram } from './Monogram'
import { displayHost } from './sources-model'
import { SourcesDialog } from './SourcesDialog'
import './sources.css'

/** How many monograms stand in the pill. */
const STACK_SIZE = 3

function SourcesView({ sources }: { sources: readonly Source[] }) {
  useLocale()

  const [open, setOpen] = useState(false)
  const pill = useRef<HTMLButtonElement>(null)
  // One monogram per host, so a pill of four pages on one site is not four of the same letter.
  const stack = useMemo(() => {
    const seen = new Set<string>()
    const picked: Source[] = []

    for (const source of sources) {
      const host = displayHost(source.url).toLowerCase()

      if (!seen.has(host)) {
        seen.add(host)
        picked.push(source)
      }

      if (picked.length === STACK_SIZE) {
        break
      }
    }

    return picked
  }, [sources])
  const close = useCallback(() => setOpen(false), [])

  if (sources.length === 0) {
    return null
  }

  return (
    <div className="hm-msg__actions">
      <button type="button" className="hm-sources-pill" ref={pill} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="hm-sources-pill__stack" aria-hidden="true">
          {stack.map(source => (
            <Monogram key={source.url} url={source.url} />
          ))}
        </span>
        <span className="hm-sources-pill__label">{sheetStrings.sources.title}</span>
        <span className="hm-sources-pill__count">{formatNumber(sources.length)}</span>
      </button>

      {open ? <SourcesDialog sources={sources} onClose={close} opener={pill.current} /> : null}
    </div>
  )
}

export const Sources = memo(SourcesView)
