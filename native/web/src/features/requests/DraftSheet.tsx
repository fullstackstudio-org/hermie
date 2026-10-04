/**
 * The sheet for a `review.draft` request: a draft the bot wrote (a mail, a post, a message, a document), shown as
 * it is, to approve, to approve with changes or to reject.
 *
 *  - **Verbatim, and never rendered.** The text is plain text in a monospaced box with `white-space: pre` (or in an
 *    editor with the same rule): no Markdown, no link, no wrapping that would hide a line break. The subject and the
 *    recipients are the bot's words and are shown apart from the body, display only.
 *  - **Bidi-safe.** What the eye cannot see (zero-width characters, direction overrides and isolates, blank letters,
 *    a tab) is counted and shown by its code point (`[U+202E]`) in a preview, never executed on screen; the gateway
 *    refuses an approved text that holds any (`text:not_verbatim`), so Approve waits until the person has taken them
 *    out. The page never rewrites what it refuses (contract §6.5: not by removing the characters, not by replacing a
 *    tab). The same goes for the layout limits (a run of spaces, an indent, blank lines, a long line): the problem is
 *    named next to the editor, with the rule and the line. The bot's own text reaches here already checked.
 *  - **Editable or not.** When the request says `editable` the text can be changed before approving; the original
 *    stays on screen for comparison once it differs, with a way back to it. Approving unchanged is `Approve`, with
 *    changes is `Approve with changes`; whether it counts as edited is the gateway's call, not the page's. When it is
 *    not editable the text cannot be touched.
 *  - **Reject** takes an optional comment (at most 1,000 characters) that the bot is told. There is no Skip: the
 *    person rejects.
 *  - What is typed is held in this component's state while the sheet is open and in the one answer; nowhere else.
 */
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

import type { AnswerOutcome } from '../../core/requests/interactive'
import {
  type DraftAsk,
  type InteractiveAnswer,
  LAYOUT_LIMITS,
  LIMITS,
  stripLineEnds,
  verbatimIssue,
  type VerbatimIssue
} from '../../core/requests/interactive-types'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { InteractiveRequest } from '../../state/interactive'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { countHiddenCharacters, markHiddenCharacters } from './verbatim-detail'

export interface DraftSheetProps {
  request: InteractiveRequest & { ask: DraftAsk }
  /** The gateway's host. */
  gateway: string
  titleId: string
  descriptionId: string
  onAnswer: (result: InteractiveAnswer) => Promise<AnswerOutcome>
  /** Put the sheet away without answering (what was edited stays while it is away). */
  onLater: () => void
  /** Milliseconds before a field or button takes anything. Tests pass 0. */
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

const lengthOf = (text: string): number => Array.from(text).length

/** Which rule of the gateway's verbatim check the text breaks, in words: what to remove. */
function ruleText(issue: VerbatimIssue, hidden: number): string {
  const words = sheetStrings.interactive.draft

  switch (issue.rule) {
    case 'character':
      return hidden > 0 ? words.hidden({ count: hidden }) : words.notVerbatim
    case 'marks':
      return words.ruleMarks
    case 'space_run':
      return words.ruleSpaceRun({ line: issue.line, size: issue.size, max: LAYOUT_LIMITS.spaceRun })
    case 'indent':
      return words.ruleIndent({ line: issue.line, size: issue.size, max: LAYOUT_LIMITS.indent })
    case 'blank_lines':
      return words.ruleBlankLines({ line: issue.line, max: LAYOUT_LIMITS.blankLines })
    case 'line_length':
      return words.ruleLineLength({ line: issue.line, size: issue.size, max: LAYOUT_LIMITS.lineChars })
  }
}

const TITLES = {
  mail: () => sheetStrings.interactive.draft.titleMail,
  post: () => sheetStrings.interactive.draft.titlePost,
  message: () => sheetStrings.interactive.draft.titleMessage,
  document: () => sheetStrings.interactive.draft.titleDocument
} as const

export function DraftSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onLater,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: DraftSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id)
  const sending = useSending()
  const editor = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(ask.text)
  const [comment, setComment] = useState('')
  /** The text was changed since the gateway's last refusal: that refusal is out of date. */
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    setChanged(false)
  }, [request.refusal])

  const locked = !armed || sending.pending || sending.finished
  const edited = ask.editable && stripLineEnds(text) !== stripLineEnds(ask.text)
  // The text as the gateway judges it: stripped first (a tab at a line end is gone, not refused).
  const stripped = stripLineEnds(text)
  const hidden = countHiddenCharacters(stripped, { tabs: true })
  const issue: VerbatimIssue | null = stripped === '' || lengthOf(text) > LIMITS.draftText ? null : verbatimIssue(text)
  const problem: 'empty' | 'long' | 'verbatim' | null =
    stripped === '' ? 'empty' : lengthOf(text) > LIMITS.draftText ? 'long' : issue ? 'verbatim' : null
  const problemText =
    problem === 'empty'
      ? sheetStrings.interactive.draft.emptyText
      : problem === 'long'
        ? sheetStrings.interactive.draft.tooLong({ max: LIMITS.draftText })
        : issue
          ? ruleText(issue, hidden)
          : null
  const commentTooLong = lengthOf(comment) > LIMITS.comment
  const problemId = `${ids}-problem`
  const commentId = `${ids}-comment`
  const commentHintId = `${ids}-comment-hint`
  const bodyId = `${ids}-body`
  const bodyNoteId = `${ids}-body-note`

  /** The gateway's refusal, in words (`text:not_verbatim`, `text:edited`, anything else as its reason). */
  const refusalText =
    request.refusal === null || (changed && request.refusal === 'text:not_verbatim')
      ? null
      : request.refusal === 'text:not_verbatim'
        ? sheetStrings.interactive.draft.notVerbatim
        : request.refusal === 'text:edited'
          ? sheetStrings.interactive.draft.refusedEdited
          : sheetStrings.interactive.refusedOther({ reason: request.refusal })

  const approve = (): void => {
    if (locked || (ask.editable && problem !== null)) {
      return
    }

    void sending.run(() => onAnswer({ decision: 'approved', text: ask.editable ? text : ask.text }))
  }

  const reject = (): void => {
    if (locked || commentTooLong) {
      return
    }

    const said = comment.trim()

    void sending.run(() => onAnswer({ decision: 'rejected', ...(said === '' ? {} : { comment: said }) }))
  }

  return (
    <InteractiveFrame
      request={request}
      gateway={gateway}
      title={TITLES[ask.kind]()}
      titleId={titleId}
      descriptionId={descriptionId}
      receiver={sheetStrings.interactive.draft.receiver}
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
          <Button className="hm-requests__action" variant="quiet" disabled={locked || commentTooLong} onClick={reject}>
            {sheetStrings.interactive.draft.reject}
          </Button>
          <Button
            className="hm-requests__action"
            variant="primary"
            disabled={locked || (ask.editable && problem !== null)}
            aria-describedby={ask.editable && problem !== null ? problemId : undefined}
            onClick={approve}
          >
            {edited ? sheetStrings.interactive.draft.approveChanged : sheetStrings.interactive.draft.approve}
          </Button>
        </>
      }
    >
      {ask.subject ? (
        <div className="hm-requests__detail-box">
          <p className="hm-requests__label">{sheetStrings.interactive.draft.subject}</p>
          <p className="hm-draft__subject" data-agent-text="">
            {ask.subject}
          </p>
        </div>
      ) : null}

      {ask.recipients.length > 0 ? (
        <div className="hm-requests__detail-box">
          <p className="hm-requests__label" id={`${ids}-recipients`}>
            {sheetStrings.interactive.draft.recipients}
          </p>
          <ul className="hm-draft__recipients" aria-labelledby={`${ids}-recipients`}>
            {ask.recipients.map((recipient, index) => (
              <li key={index} data-agent-text="">
                {recipient}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="hm-requests__detail-box">
        {ask.editable ? (
          <>
            <label className="hm-requests__label" htmlFor={bodyId}>
              {sheetStrings.interactive.draft.body}
            </label>
            <textarea
              id={bodyId}
              ref={editor}
              className="hm-draft__text hm-draft__editor"
              rows={12}
              wrap="off"
              dir="auto"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              value={text}
              disabled={locked}
              aria-describedby={[bodyNoteId, problem !== null ? problemId : ''].filter(Boolean).join(' ')}
              aria-invalid={problem !== null ? true : undefined}
              onChange={event => {
                setText(event.currentTarget.value)
                setChanged(true)
                sending.clearNotice()
              }}
              data-draft-editor=""
            />
            <p className="hm-form__hint" id={bodyNoteId}>
              {sheetStrings.interactive.draft.editable}
            </p>
          </>
        ) : (
          <>
            <p className="hm-requests__label" id={bodyId}>
              {sheetStrings.interactive.draft.body}
            </p>
            <pre
              className="hm-draft__text"
              dir="auto"
              tabIndex={0}
              aria-labelledby={bodyId}
              aria-describedby={bodyNoteId}
              data-draft-text=""
            >
              {markHiddenCharacters(ask.text, { tabs: true })}
            </pre>
            <p className="hm-form__hint" id={bodyNoteId}>
              {sheetStrings.interactive.draft.fixed}
            </p>
          </>
        )}
      </div>

      {ask.editable && problem !== null ? (
        <div className="hm-draft__problem">
          <p className="hm-form__error" id={problemId} role="status">
            {problemText}
          </p>
          {hidden > 0 ? (
            <>
              <div className="hm-requests__detail-box">
                <p className="hm-requests__label" id={`${ids}-marked`}>
                  {sheetStrings.interactive.draft.hiddenPreview}
                </p>
                <pre className="hm-draft__text" dir="auto" tabIndex={0} aria-labelledby={`${ids}-marked`}>
                  {markHiddenCharacters(stripped, { tabs: true })}
                </pre>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {edited ? (
        <div className="hm-requests__detail-box">
          <p className="hm-requests__label" id={`${ids}-original`}>
            {sheetStrings.interactive.draft.original}
          </p>
          <pre
            className="hm-draft__text hm-draft__original"
            dir="auto"
            tabIndex={0}
            aria-labelledby={`${ids}-original`}
          >
            {markHiddenCharacters(ask.text, { tabs: true })}
          </pre>
          <Button
            variant="quiet"
            disabled={locked}
            onClick={() => {
              setText(ask.text)
              setChanged(true)
              editor.current?.focus()
            }}
          >
            {sheetStrings.interactive.draft.reset}
          </Button>
        </div>
      ) : null}

      <div className="hm-requests__detail-box">
        <label className="hm-requests__label" htmlFor={commentId}>
          {sheetStrings.interactive.draft.commentLabel}
        </label>
        <textarea
          id={commentId}
          className="hm-requests__field"
          rows={2}
          autoComplete="off"
          value={comment}
          disabled={locked}
          aria-describedby={commentHintId}
          aria-invalid={commentTooLong ? true : undefined}
          onChange={event => {
            setComment(event.currentTarget.value)
            sending.clearNotice()
          }}
        />
        <p className="hm-form__hint" id={commentHintId}>
          {commentTooLong
            ? sheetStrings.interactive.form.problems.tooLong({ max: LIMITS.comment })
            : sheetStrings.interactive.draft.commentHint}
        </p>
      </div>
    </InteractiveFrame>
  )
}
