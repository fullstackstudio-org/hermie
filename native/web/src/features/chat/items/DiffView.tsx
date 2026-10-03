/**
 * A unified diff: one line per row, the added and removed ones tinted, the old
 * and new line numbers in a gutter.
 *
 * The parity source is the Expo app's `chat-ui/DiffView.tsx` and the Swift app's
 * `DiffText` (`HermieUI/Items/ToolItemView.swift`). What the browser adds is what
 * a colour cannot say to somebody who does not see it:
 *
 *  - **An added line is an `<ins>` and a removed one a `<del>`**, and each starts
 *    with a word only assistive technology reads ("Added", "Removed"): most
 *    screen readers say nothing about `<ins>` and `<del>` unless asked, so the
 *    element is the semantics and the word is what is actually heard. The `+`
 *    and `-` markers and the gutter are decoration and are hidden from it.
 *  - **The scroll area is a group named by what it holds** (not a landmark: a
 *    chat holds many diffs, often with the same counts): how many lines are added and
 *    removed, which is also the one line shown above it.
 *  - **It scrolls sideways rather than wrapping** (a wrapped diff line reads as
 *    two edits), so it takes the keyboard: a scroll region nobody can reach is a
 *    trap.
 *
 * The diff is the gateway's text and is drawn as characters, never as markup.
 * Past `maxLines` the rest is dropped with a count, as the native apps do.
 */
import { memo, useId, useMemo } from 'react'

import { useLocale } from '../../../i18n/use-locale'
import { webStrings } from '../../../i18n/web-strings'
import { diffCounts, type DiffLine, parseUnifiedDiff } from './diff'
import { VisuallyHidden } from '../../../ui/primitives'
import './media.css'

export interface DiffViewProps {
  /** The unified diff, as the gateway sent it. */
  diff: string
  /** Lines beyond this are left out with a count; 0 shows every line. */
  maxLines?: number
}

/** The default line budget: the Expo app's. */
export const DIFF_MAX_LINES = 160

function marker(kind: DiffLine['kind']): string {
  if (kind === 'add') {
    return '+'
  }

  if (kind === 'delete') {
    return '−'
  }

  return ' '
}

function LineText({ line }: { line: DiffLine }) {
  // A line with nothing on it still takes its height, so the gutter keeps lining up.
  const text = line.text === '' ? ' ' : line.text

  if (line.kind === 'add') {
    return (
      <ins className="hm-diff__text">
        <VisuallyHidden>{webStrings.itemViews.diff.added} </VisuallyHidden>
        {text}
      </ins>
    )
  }

  if (line.kind === 'delete') {
    return (
      <del className="hm-diff__text">
        <VisuallyHidden>{webStrings.itemViews.diff.removed} </VisuallyHidden>
        {text}
      </del>
    )
  }

  return <span className="hm-diff__text">{text}</span>
}

function DiffViewImpl({ diff, maxLines = DIFF_MAX_LINES }: DiffViewProps) {
  useLocale()

  const summaryId = useId()
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const counts = useMemo(() => diffCounts(lines), [lines])
  const shown = maxLines > 0 ? lines.slice(0, maxLines) : lines
  const hidden = lines.length - shown.length

  if (lines.length === 0) {
    return null
  }

  return (
    <figure className="hm-diff">
      <figcaption className="hm-diff__summary" id={summaryId}>
        {webStrings.itemViews.diff.summary(counts)}
      </figcaption>

      <div className="hm-diff__scroll" tabIndex={0} role="group" aria-labelledby={summaryId}>
        <div className="hm-diff__lines">
          {shown.map((line, index) => (
            <div className="hm-diff__line" data-kind={line.kind} key={index}>
              <span className="hm-diff__gutter" aria-hidden="true">
                {line.oldLine ?? ''}
              </span>
              <span className="hm-diff__gutter" aria-hidden="true">
                {line.newLine ?? ''}
              </span>
              <span className="hm-diff__marker" aria-hidden="true">
                {marker(line.kind)}
              </span>
              <LineText line={line} />
            </div>
          ))}
        </div>
      </div>

      {hidden > 0 ? <p className="hm-diff__more">{webStrings.itemViews.diff.more({ count: hidden })}</p> : null}
    </figure>
  )
}

export const DiffView = memo(DiffViewImpl)
