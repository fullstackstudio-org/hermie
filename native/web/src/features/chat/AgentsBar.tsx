/**
 * The Agents bar, over the composer while a bot has subagents at work: "3 agents working · 0:42 · Show", and the
 * panel it opens (the Expo app's `AgentsBar` and `AgentsSheet`, as a strip of the chat in the way `TodoList` is one:
 * the delegation tree is a thing about "now", so it lives with the other things about now, above the field).
 *
 * **The bar** counts the children that are queued or running and ticks the clock from the earliest start (epoch
 * milliseconds, `Subagent.startedAt`). It is drawn while anything runs, and while its panel is open, so a panel
 * that is being read does not vanish under the reader when the last child finishes: it then says no agent runs.
 * One polite region says the count when it changes; the clock is not announced and is hidden from assistive
 * technology, since a name that changes every second is no name.
 *
 * **The panel** is the tree, roots first and children under their parent, a row each: the goal, its status in words,
 * how long it has run, the tool it is on, the last lines of what it wrote and, once it ends, its summary. A running
 * child has two actions, **Steer** (a correction in the reader's words, sent with `subagent.steer`: it opens a field
 * under the row, which takes the focus) and **Stop** (`subagent.interrupt`), and a child with a session of its own has
 * **Open transcript**, which takes the panel's place (`useSubagentTranscript`: the live tail while it runs, the stored
 * transcript once it has finished) under a way back. What an action did, or why it did not, is one polite line over
 * the tree. Escape goes back one level: out of the steer field, out of a transcript, out of the panel; the focus
 * goes back to the control that opened what was closed.
 *
 * Everything an agent wrote (its goal, its stream, its summary, its transcript) is cleaned and bounded
 * (`displayText`) and drawn as plain text, never Markdown, in an isolated run.
 */
import { type Subagent, type SubagentNode, subagentTree, type ChatState } from '@hermie/transcript'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { useStore } from 'zustand'

import { isLiveSubagent, oldestStartMs } from '../../core/chats/subagent-transcript'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { chatsStore } from '../../state/chats'
import { Icon } from '../../ui/icons'
import { Button, VisuallyHidden } from '../../ui/primitives'
import { formatDuration, formatElapsedClock } from './chat-format'
import { type ChatScreenController, useChatRuntime } from './chat-runtime'
import { statusGlyph } from './items/SubagentGroupCard'
import { useSubagentTranscript } from './use-subagent-transcript'
import './agents-bar.css'

/** What a goal, a stream line, a summary, a tool and a transcript are cut to when drawn. */
const GOAL_CHARS = 600
const LINE_CHARS = 300
const SUMMARY_CHARS = 4_000
const TOOL_CHARS = 120
const TRANSCRIPT_CHARS = 20_000
/** The lines of a child's stream the row shows: the newest. */
const STREAM_LINES = 4

/** A stable empty map, so a chat without children does not churn the memo. */
const NO_SUBAGENTS: Readonly<Record<string, Subagent>> = Object.freeze({})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The seconds since `startedAt` (epoch milliseconds), once a second while `ticking`. */
function useElapsedSeconds(startedAtMs: number | undefined, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!ticking || startedAtMs === undefined) {
      return
    }

    setNow(Date.now())

    const timer = setInterval(() => setNow(Date.now()), 1_000)

    return () => clearInterval(timer)
  }, [ticking, startedAtMs])

  return startedAtMs === undefined ? 0 : Math.max(0, (now - startedAtMs) / 1_000)
}

export interface AgentsBarProps {
  /** The chat the children belong to: the key the chat store and the controller know it by. */
  chatKey: string
}

export function AgentsBar({ chatKey }: AgentsBarProps): ReactElement {
  useLocale()

  const controller = useChatRuntime()?.controller
  const subagents = useStore(chatsStore, state => state.chats[chatKey]?.subagents ?? NO_SUBAGENTS)
  const running = useMemo(() => Object.values(subagents).filter(isLiveSubagent), [subagents])
  const count = running.length
  const startedAt = useMemo(() => oldestStartMs(running), [running])
  const elapsed = useElapsedSeconds(startedAt, count > 0)

  const [open, setOpen] = useState(false)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const panelId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  /** The Open transcript button of each row, so Back can put the focus where the reader came from. */
  const openers = useRef(new Map<string, HTMLButtonElement>())

  // A different chat is a different panel: nothing open, nothing said.
  useEffect(() => {
    setOpen(false)
    setTranscript(null)
    setNotice('')
  }, [chatKey])

  const tree = useMemo(() => subagentTree({ subagents } as unknown as ChatState), [subagents])
  const shown = count > 0 || open

  const closeTranscript = useCallback((): void => {
    const was = transcript

    setTranscript(null)

    // After the panel has drawn the tree again.
    if (was !== null) {
      requestAnimationFrame(() => openers.current.get(was)?.focus())
    }
  }, [transcript])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (transcript !== null) {
      closeTranscript()

      return
    }

    setOpen(false)
    toggle.current?.focus()
  }

  return (
    <>
      {/* The count, said when it changes; the clock is not. */}
      <div className="hm-sr" role="status" aria-live="polite" aria-atomic="true">
        {count > 0 ? strings.chat.subagents.barCount({ count }) : ''}
      </div>

      {shown ? (
        <section
          className="hm-agentsbar"
          aria-label={strings.chat.subagents.title}
          data-open={open ? 'true' : 'false'}
          onKeyDown={onKeyDown}
        >
          <button
            ref={toggle}
            className="hm-agentsbar__head"
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => {
              setOpen(!open)
              setTranscript(null)
            }}
          >
            <span className="hm-agentsbar__pips" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="hm-agentsbar__count">
              {count > 0 ? strings.chat.subagents.barCount({ count }) : strings.chat.subagents.idle}
            </span>
            {count > 0 ? (
              <span className="hm-agentsbar__clock" aria-hidden="true">
                {formatElapsedClock(elapsed)}
              </span>
            ) : null}
            <span className="hm-agentsbar__open">
              {open ? sheetStrings.agents.hide : strings.chat.subagents.barOpen}
            </span>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
          </button>

          {open ? (
            <div className="hm-agentsbar__panel" id={panelId}>
              <p className="hm-agentsbar__notice" role="status" data-empty={notice === '' ? 'true' : 'false'}>
                {notice}
              </p>
              {transcript !== null && subagents[transcript] ? (
                <TranscriptView
                  chatKey={chatKey}
                  child={subagents[transcript]}
                  reader={controller}
                  onBack={closeTranscript}
                />
              ) : tree.length > 0 ? (
                <ul className="hm-agentsbar__tree">
                  {tree.map(node => (
                    <AgentRow
                      key={node.id}
                      node={node}
                      depth={0}
                      chatKey={chatKey}
                      controller={controller}
                      onNotice={setNotice}
                      onOpenTranscript={setTranscript}
                      openers={openers.current}
                    />
                  ))}
                </ul>
              ) : (
                <p className="hm-agentsbar__idle">{strings.chat.subagents.idle}</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

interface AgentRowProps {
  node: SubagentNode
  depth: number
  chatKey: string
  controller: ChatScreenController | undefined
  onNotice: (text: string) => void
  onOpenTranscript: (id: string) => void
  openers: Map<string, HTMLButtonElement>
}

/** One child: what it is doing, its actions, and its own children under it. */
function AgentRow({
  node,
  depth,
  chatKey,
  controller,
  onNotice,
  onOpenTranscript,
  openers
}: AgentRowProps): ReactElement {
  const live = isLiveSubagent(node)
  const [steering, setSteering] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const steerButton = useRef<HTMLButtonElement>(null)
  const stopped = useRef(false)
  const goal = displayText(node.goal, GOAL_CHARS)
  const words = strings.chat.subagents

  // The field takes the focus when it opens.
  useEffect(() => {
    if (steering) {
      field.current?.focus()
    }
  }, [steering])

  // A child that was stopped has no Stop button when it is over: the focus goes to its row, not to the page.
  useEffect(() => {
    if (!live && stopped.current) {
      stopped.current = false

      if (
        !row.current?.contains(row.current.ownerDocument.activeElement) ||
        row.current.ownerDocument.activeElement === row.current.ownerDocument.body
      ) {
        row.current?.focus()
      }
    }
  }, [live])

  const failed = (error: unknown): void =>
    onNotice(sheetStrings.agents.actionFailed({ reason: displayText(messageOf(error), LINE_CHARS) }))

  const steer = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    const text = draft.trim()

    // One at a time; the field keeps what was typed until the gateway has taken it.
    if (!text || !controller || sending) {
      return
    }

    setSending(true)
    controller
      .steerSubagent(chatKey, node.id, text)
      .then(status => {
        onNotice(status === 'rejected' ? words.steerRejected : words.steerQueued)
        setDraft('')
        setSteering(false)
        steerButton.current?.focus()
      })
      .catch(failed)
      .finally(() => setSending(false))
  }

  const stop = (): void => {
    if (!controller) {
      return
    }

    stopped.current = true
    controller
      .interruptSubagent(chatKey, node.id)
      .then(found => onNotice(found ? words.stopped : words.status.completed))
      .catch((error: unknown) => {
        stopped.current = false
        failed(error)
      })
  }

  const duration = formatDuration(node.durationSeconds ?? Math.max(0, (node.updatedAt - node.startedAt) / 1_000))
  const lines = node.stream.slice(-STREAM_LINES)

  return (
    <li className="hm-agentsbar__row" data-depth={Math.min(depth, 3)} data-status={node.status} ref={row} tabIndex={-1}>
      <p className="hm-agentsbar__line">
        <span className="hm-agentsbar__glyph" aria-hidden="true">
          {statusGlyph(node.status)}
        </span>
        <span className="hm-agentsbar__goal">
          <bdi>{goal}</bdi>
        </span>
        {duration ? <span className="hm-agentsbar__duration">{duration}</span> : null}
      </p>
      <p className="hm-agentsbar__meta">
        <span className="hm-agentsbar__status">{words.status[node.status]}</span>
        {node.currentTool ? (
          <span className="hm-agentsbar__tool">
            <bdi>{displayText(node.currentTool, TOOL_CHARS)}</bdi>
          </span>
        ) : null}
      </p>

      {lines.length > 0 ? (
        <ul className="hm-agentsbar__stream">
          {lines.map((entry, index) => (
            <li key={index} data-error={entry.isError ? 'true' : undefined} dir="auto">
              {displayText(entry.text, LINE_CHARS)}
            </li>
          ))}
        </ul>
      ) : null}

      {node.summary ? (
        <p className="hm-agentsbar__summary" dir="auto">
          {displayText(node.summary, SUMMARY_CHARS)}
        </p>
      ) : null}

      <div className="hm-agentsbar__actions">
        {live && controller ? (
          <Button
            ref={steerButton}
            variant="quiet"
            aria-expanded={steering}
            onClick={() => setSteering(current => !current)}
          >
            {words.steer}
            <VisuallyHidden>{goal}</VisuallyHidden>
          </Button>
        ) : null}
        {live && controller ? (
          <Button variant="quiet" data-tone="danger" onClick={stop}>
            {words.stop}
            <VisuallyHidden>{goal}</VisuallyHidden>
          </Button>
        ) : null}
        {node.childSessionId && controller ? (
          <Button
            ref={element => {
              if (element) {
                openers.set(node.id, element)
              } else {
                openers.delete(node.id)
              }
            }}
            variant="quiet"
            onClick={() => onOpenTranscript(node.id)}
          >
            {words.openTranscript}
            <VisuallyHidden>{goal}</VisuallyHidden>
          </Button>
        ) : null}
      </div>

      {steering ? (
        <form
          className="hm-agentsbar__steer"
          onSubmit={steer}
          onKeyDown={event => {
            // Escape leaves the field and nothing more: the panel stays.
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setSteering(false)
              steerButton.current?.focus()
            }
          }}
        >
          <input
            ref={field}
            type="text"
            value={draft}
            aria-label={`${words.steerPlaceholder} ${goal}`}
            placeholder={words.steerPlaceholder}
            autoComplete="off"
            onChange={event => setDraft(event.currentTarget.value)}
          />
          <Button type="submit" aria-busy={sending} disabled={draft.trim() === ''}>
            {words.steer}
          </Button>
        </form>
      ) : null}

      {node.children.length > 0 ? (
        <ul className="hm-agentsbar__tree">
          {node.children.map(child => (
            <AgentRow
              key={child.id}
              node={child}
              depth={depth + 1}
              chatKey={chatKey}
              controller={controller}
              onNotice={onNotice}
              onOpenTranscript={onOpenTranscript}
              openers={openers}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** One child's transcript, in the panel's place: a way back, which source it is, and the text. */
function TranscriptView({
  chatKey,
  child,
  reader,
  onBack
}: {
  chatKey: string
  child: Subagent
  reader: ChatScreenController | undefined
  onBack: () => void
}): ReactElement {
  const { text, source, loading, error } = useSubagentTranscript(reader, chatKey, child)
  const heading = useRef<HTMLHeadingElement>(null)
  const title = strings.chat.subagents.transcriptTitle({ goal: displayText(child.goal, GOAL_CHARS) })
  const shown = displayText(text.length > TRANSCRIPT_CHARS ? text.slice(-TRANSCRIPT_CHARS) : text, TRANSCRIPT_CHARS)

  // Where the reader is told they are.
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <div className="hm-agentsbar__transcript">
      <div className="hm-agentsbar__transcript-head">
        <Button variant="quiet" onClick={onBack}>
          <Icon name="chevronLeft" size={16} />
          {strings.chat.subagents.transcriptBack}
        </Button>
        <h3 className="hm-agentsbar__transcript-title" ref={heading} tabIndex={-1}>
          <bdi>{title}</bdi>
        </h3>
      </div>
      <p className="hm-agentsbar__source">
        {source === 'tail' ? strings.chat.subagents.transcriptLive : strings.chat.subagents.transcriptStored}
      </p>
      {error ? (
        <p className="hm-agentsbar__error" role="alert">
          {sheetStrings.agents.readFailed({ reason: displayText(error, LINE_CHARS) })}
        </p>
      ) : null}
      <div className="hm-agentsbar__text" role="region" aria-label={title} tabIndex={0}>
        {loading ? (
          <p role="status">{sheetStrings.agents.loading}</p>
        ) : (
          <pre dir="auto">{shown || strings.chat.subagents.transcriptEmpty}</pre>
        )}
      </div>
    </div>
  )
}
