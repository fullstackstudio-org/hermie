/**
 * The sheet for a `review.diff` request: the changes a bot wants to make to ONE file, hunk by hunk, each to approve or
 * to reject (`contract/requests` §7).
 *
 *  - **Every line as it is.** A hunk is drawn monospaced, one row per line, the marker in a gutter apart from the text.
 *    An added or a removed line differs from a context line by its marker and a word for a screen reader, not by colour
 *    alone. The text is plain text with `white-space: pre`: nothing is trimmed, re-wrapped, re-ordered or turned into a
 *    link, and a tab is a stop of 8 columns (the contract's), never collapsed. The reader refused every frame with a line
 *    the person could not see as it is (`readDiff`), so what is drawn is all there is.
 *  - **Nothing cut off in silence.** A row wider than the view scrolls sideways inside its hunk, and the hunk says so: an
 *    edge fade on the side that has more, a scroll bar that stays on screen, and a line of words (README §7.1). The
 *    scrolling box takes the keyboard.
 *  - **Where it lands, not where the header says.** `git apply` finds a hunk by its content: only the start and the end
 *    of the file are certain, and the reader reports which (`anchor`). The sheet says "Start of the file", "End of the
 *    file" or "Whole file" next to the header; for the end it does NOT draw the header's line numbers at all, because
 *    the change goes after the last line wherever those numbers point.
 *  - **Decided by the person, hunk by hunk.** Approve and Reject are toggles on each hunk, with Approve all and Reject all
 *    for the lot. Nothing is sent until EVERY hunk is decided (the answer has an entry for each), and nothing is
 *    decided for the person: a hunk starts undecided. The answer is `{decision, hunks}` and nothing else (`composeDiffAnswer`).
 *  - What is decided is held in this component's state while the sheet is open and in the one answer; nowhere else.
 */
import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import type { AnswerOutcome } from '../../core/requests/interactive'
import {
  composeDiffAnswer,
  type DiffAsk,
  type DiffHunk,
  type HunkDecision,
  type InteractiveAnswer,
  parseHunkHeader
} from '../../core/requests/interactive-types'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { InteractiveRequest } from '../../state/interactive'
import { layoutClock } from '../../platform/layout'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import './diff-sheet.css'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'

export interface DiffSheetProps {
  request: InteractiveRequest & { ask: DiffAsk }
  /** The gateway's host. */
  gateway: string
  titleId: string
  descriptionId: string
  onAnswer: (result: InteractiveAnswer) => Promise<AnswerOutcome>
  /** Put the sheet away without answering (what was decided stays while it is away). */
  onLater: () => void
  /** Whether the sheet is the one on screen: its tap guard runs from the moment it is (default: it is). */
  shown?: boolean
  /** Milliseconds before a button takes anything. Tests pass 0. */
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

type Decisions = Readonly<Record<string, HunkDecision | undefined>>

/** The words for where a hunk lands, or none for a hunk that is not pinned. */
const anchorText = (hunk: DiffHunk): string | null =>
  hunk.anchor === 'start'
    ? sheetStrings.interactive.diff.anchorStart
    : hunk.anchor === 'end'
      ? sheetStrings.interactive.diff.anchorEnd
      : hunk.anchor === 'both'
        ? sheetStrings.interactive.diff.anchorBoth
        : null

/**
 * What to draw next to the label of a hunk's place: the header as it is, except for a hunk pinned to the END of the
 * file, whose header's line numbers are not where it lands, so only its section text (the function it is in) is shown.
 */
function headerText(hunk: DiffHunk): string {
  if (hunk.anchor !== 'end') {
    return hunk.header
  }

  return parseHunkHeader(hunk.header)?.section ?? ''
}

const MARKERS = { context: ' ', added: '+', removed: '-', note: '\\' } as const

/** Which ways a hunk's lines are wider than the view or have more beyond the edge. */
interface Reach {
  wide: boolean
  moreStart: boolean
  moreEnd: boolean
}

const NO_REACH: Reach = { wide: false, moreStart: false, moreEnd: false }

/** Measures a scrolling box: wider than its view, and which edges have more beyond them. */
function useReach(): { ref: RefObject<HTMLDivElement | null>; reach: Reach; measure: () => void } {
  const ref = useRef<HTMLDivElement>(null)
  const [reach, setReach] = useState<Reach>(NO_REACH)

  const measure = useCallback((): void => {
    const element = ref.current

    if (!element) {
      return
    }

    const wide = element.scrollWidth - element.clientWidth > 1
    const next: Reach = {
      wide,
      moreStart: wide && element.scrollLeft > 1,
      moreEnd: wide && element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    }

    setReach(previous =>
      previous.wide === next.wide && previous.moreStart === next.moreStart && previous.moreEnd === next.moreEnd
        ? previous
        : next
    )
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  // A box that changes size (a window resized, a phone turned) may start or stop being too narrow.
  useEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    const watch = layoutClock.observeResize(measure)

    watch.watch(element)

    return () => watch.disconnect()
  }, [measure])

  return { ref, reach, measure }
}

interface HunkViewProps {
  hunk: DiffHunk
  /** 1-based place in the request, and how many there are. */
  n: number
  total: number
  decision: HunkDecision | undefined
  locked: boolean
  onDecide: (decision: HunkDecision) => void
}

function HunkView({ hunk, n, total, decision, locked, onDecide }: HunkViewProps): ReactElement {
  const words = sheetStrings.interactive.diff
  const ids = useId()
  const { ref, reach, measure } = useReach()
  const label = anchorText(hunk)
  const header = headerText(hunk)
  const noteId = `${ids}-wide`

  return (
    <section className="hm-review__hunk" aria-labelledby={`${ids}-title`} data-hunk={hunk.id} data-decision={decision}>
      <div className="hm-review__head">
        <h3 className="hm-review__hunk-title" id={`${ids}-title`}>
          {words.hunk({ n, total })}
        </h3>
        {label === null ? null : (
          <span className="hm-review__anchor" data-anchor={hunk.anchor}>
            {label}
          </span>
        )}
        {header === '' ? null : (
          <code className="hm-review__header" data-agent-text="">
            {header}
          </code>
        )}
      </div>

      <div
        className="hm-review__frame"
        data-more-start={reach.moreStart || undefined}
        data-more-end={reach.moreEnd || undefined}
      >
        {/* Scrolls sideways when a row is wider than the view, so it takes the keyboard (arrows, Home, End). */}
        <div
          ref={ref}
          className="hm-review__lines"
          role="region"
          tabIndex={0}
          aria-label={words.lines({ n })}
          aria-describedby={reach.wide ? noteId : undefined}
          data-overflow={reach.wide || undefined}
          onScroll={measure}
        >
          <div className="hm-review__rows">
            {hunk.lines.map((line, index) => (
              <div key={index} className="hm-review__row" data-type={line.type}>
                <span className="hm-review__marker" aria-hidden="true">
                  {MARKERS[line.type]}
                </span>
                <span className="hm-review__kind-word">
                  {line.type === 'added'
                    ? words.lineAdded
                    : line.type === 'removed'
                      ? words.lineRemoved
                      : line.type === 'note'
                        ? words.lineNote
                        : words.lineContext}
                  {': '}
                </span>
                <span className="hm-review__text" data-agent-text="">
                  {line.type === 'note' ? '\\ No newline at end of file' : line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {reach.wide ? (
        <p className="hm-requests__meta" id={noteId} data-wide="">
          {words.wide}
        </p>
      ) : null}

      <div className="hm-review__decision" role="group" aria-label={words.hunk({ n, total })}>
        <Button
          className="hm-review__choice"
          variant="quiet"
          disabled={locked}
          aria-pressed={decision === 'approved'}
          aria-label={words.approveHunk({ n, total })}
          data-choice="approved"
          onClick={() => onDecide('approved')}
        >
          {words.approve}
        </Button>
        <Button
          className="hm-review__choice"
          variant="quiet"
          disabled={locked}
          aria-pressed={decision === 'rejected'}
          aria-label={words.rejectHunk({ n, total })}
          data-choice="rejected"
          onClick={() => onDecide('rejected')}
        >
          {words.reject}
        </Button>
      </div>
    </section>
  )
}

export function DiffSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onLater,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: DiffSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const words = sheetStrings.interactive.diff
  const undecidedId = `${useId()}-undecided`
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  // An answer on its way is not cut off by a question that arrives meanwhile (`sheet-order.ts`).
  useReportBusy(sending.pending)
  // Nothing is decided for the person: every hunk starts undecided.
  const [decisions, setDecisions] = useState<Decisions>({})

  const locked = !armed || sending.pending || sending.finished
  const total = ask.hunks.length
  const approved = ask.hunks.filter(hunk => decisions[hunk.id] === 'approved').length
  const rejected = ask.hunks.filter(hunk => decisions[hunk.id] === 'rejected').length
  const undecided = total - approved - rejected
  const answer = composeDiffAnswer(ask, decisions)

  const decide = (id: string, decision: HunkDecision): void => {
    if (locked) {
      return
    }

    setDecisions(previous => ({ ...previous, [id]: decision }))
    sending.clearNotice()
  }

  const decideAll = (decision: HunkDecision): void => {
    if (locked) {
      return
    }

    setDecisions(Object.fromEntries(ask.hunks.map(hunk => [hunk.id, decision])))
    sending.clearNotice()
  }

  const send = (): void => {
    if (locked || answer === null) {
      return
    }

    void sending.run(() => onAnswer(answer))
  }

  const refusalText =
    request.refusal === null ? null : sheetStrings.interactive.refusedOther({ reason: request.refusal })
  const sendLabel =
    answer === null ? words.send : approved > 0 ? words.sendApproved({ approved, total }) : words.sendRejected
  const kindWord =
    ask.kind === 'new'
      ? words.kindNew
      : ask.kind === 'delete'
        ? words.kindDelete
        : ask.kind === 'rename'
          ? words.kindRename
          : words.kindModify

  return (
    <InteractiveFrame
      request={request}
      gateway={gateway}
      title={words.title}
      titleId={titleId}
      descriptionId={descriptionId}
      receiver={words.receiver}
      {...(now ? { now } : {})}
      status={
        <>
          <RefusalAlert text={refusalText} />
          <SendStatus notice={sending.notice} />
        </>
      }
      actions={
        <>
          <Button className="hm-requests__action" variant="quiet" onClick={onLater}>
            {sheetStrings.interactive.later}
          </Button>
          <Button
            className="hm-requests__action"
            variant="primary"
            disabled={locked || answer === null}
            aria-describedby={answer === null ? undecidedId : undefined}
            data-send=""
            onClick={send}
          >
            {sendLabel}
          </Button>
        </>
      }
    >
      <div className="hm-requests__detail-box">
        <p className="hm-requests__label">{words.file}</p>
        <p className="hm-review__path" data-agent-text="" data-kind={ask.kind}>
          {/* Each path is its own isolated, left-to-right run: one cannot reorder the other or the arrow between. */}
          {ask.kind === 'rename' && ask.oldPath !== undefined ? (
            <>
              <bdi dir="ltr" data-path="old">
                {ask.oldPath}
              </bdi>
              {' → '}
              <bdi dir="ltr" data-path="new">
                {ask.path}
              </bdi>
            </>
          ) : (
            <bdi dir="ltr" data-path="new">
              {ask.path}
            </bdi>
          )}
        </p>
        <p className="hm-requests__meta" data-file-kind="">
          {kindWord}
        </p>
      </div>

      <div className="hm-review__bulk">
        <Button
          className="hm-review__bulk-button"
          variant="quiet"
          disabled={locked}
          data-bulk="approved"
          onClick={() => decideAll('approved')}
        >
          {words.approveAll}
        </Button>
        <Button
          className="hm-review__bulk-button"
          variant="quiet"
          disabled={locked}
          data-bulk="rejected"
          onClick={() => decideAll('rejected')}
        >
          {words.rejectAll}
        </Button>
        <p className="hm-requests__meta hm-review__progress" data-progress="" aria-live="polite">
          {words.progress({ approved, rejected, undecided })}
        </p>
      </div>

      <div className="hm-review__hunks">
        {ask.hunks.map((hunk, index) => (
          <HunkView
            key={hunk.id}
            hunk={hunk}
            n={index + 1}
            total={total}
            decision={decisions[hunk.id]}
            locked={locked}
            onDecide={decision => decide(hunk.id, decision)}
          />
        ))}
      </div>

      {answer === null ? (
        <p className="hm-requests__meta" id={undecidedId}>
          {words.decideAll({ count: undecided })}
        </p>
      ) : null}
    </InteractiveFrame>
  )
}
