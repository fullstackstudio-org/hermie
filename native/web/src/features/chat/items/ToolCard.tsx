/**
 * A tool call: one collapsed line, and its detail as plain text when opened.
 *
 * The line is a button (`aria-expanded`): the tool's family glyph, its name,
 * what it did, and how long it took or that it is still running or failed.
 * Opened, it shows the warning when the output was flagged as untrusted, the
 * arguments, the diff a patch produced (`DiffView`), what came back (or what went wrong) and
 * the raw arguments the gateway sends at its verbose setting: all of it as
 * characters in a `pre`-style block, never Markdown, because none of it was
 * written for a reader.
 *
 * A tool whose interface is somewhere else (`todo`, a reaction) draws nothing
 * while it succeeds, and does draw when it fails, because a failure nobody can
 * see is the worst of both. At the verbose level the selectors hand the card
 * over as `full` and it starts opened; one click pins it either way, and a
 * verbosity change after that leaves it where the reader put it.
 *
 * The one line of the collapsed card is bounded and cleaned (`displayText`): it
 * stands next to the app's own words, and a summary carrying a direction
 * override must not reorder them. The body is the tool's text, whole.
 */
import type { ToolItem } from '@hermie/transcript'
import { memo, type ReactNode, useId, useState } from 'react'

import { displayText } from '../../../core/requests/secure-input'
import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { Icon } from '../../../ui/icons'
import { formatDuration } from '../chat-format'
import { DiffView } from './DiffView'
import { type RowViewProps, sameRowView } from './row-view'
import {
  argumentLines,
  errorText,
  isSilentTool,
  LONG_VALUE_CHARS,
  resultText,
  toolFamily,
  toolGlyph,
  toolSummary
} from './tool-text'

/** The longest tool name the line carries; a gateway's names are short, an MCP one is not. */
const TOOL_NAME_CHARS = 80

/** A long value, folded behind a button so one tool result cannot be the whole screen. */
function Value({ text }: { text: string }) {
  useLocale()

  const [open, setOpen] = useState(false)
  const long = text.length > LONG_VALUE_CHARS

  return (
    <>
      <pre className="hm-tool__text">{long && !open ? `${text.slice(0, LONG_VALUE_CHARS)}…` : text}</pre>
      {long ? (
        <button className="hm-linkish" type="button" aria-expanded={open} onClick={() => setOpen(current => !current)}>
          {open ? strings.chat.tool.showLess : strings.chat.tool.showMore}
        </button>
      ) : null}
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="hm-tool__section">
      <p className="hm-tool__heading">{title}</p>
      {children}
    </section>
  )
}

function ToolCardView({ item, presentation }: RowViewProps<ToolItem>) {
  useLocale()

  const bodyId = useId()
  // `null` is "the reader has not decided": a verbosity change still opens and closes the card.
  const [chosen, setChosen] = useState<boolean | null>(null)

  const failed = Boolean(item.isError) || item.status === 'error'

  if (presentation === 'hidden-placeholder' || (isSilentTool(item.name) && !failed)) {
    return null
  }

  const name = displayText(item.name, TOOL_NAME_CHARS) || item.toolId
  const glyph = failed ? '!' : toolGlyph(toolFamily(item.name))

  // The selectors never hand a tool over as a chip today; a chip is still a name, never nothing.
  if (presentation === 'chip') {
    return (
      <p className="hm-chip" data-kind="tool" data-failed={failed ? 'true' : 'false'}>
        <bdi>{name}</bdi>
      </p>
    )
  }

  const open = chosen ?? presentation === 'full'
  const running = item.status === 'running' || item.status === 'generating'
  const duration = formatDuration(item.durationS)
  const summary = displayText(toolSummary(item), 160)
  const args = argumentLines(item.args)
  const result = item.resultKnown ? resultText(item) : ''
  const state = running
    ? item.status === 'generating'
      ? strings.chat.tool.generating
      : strings.chat.tool.running
    : failed
      ? strings.chat.tool.failed
      : duration

  return (
    <article
      className="hm-tool"
      data-failed={failed ? 'true' : 'false'}
      data-running={running ? 'true' : 'false'}
      data-family={toolFamily(item.name)}
    >
      <button
        className="hm-tool__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setChosen(!open)}
      >
        <span className="hm-tool__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="hm-tool__name">
          <bdi>{name}</bdi>
        </span>
        {summary ? (
          <span className="hm-tool__summary">
            <bdi>{summary}</bdi>
          </span>
        ) : null}
        {state ? <span className="hm-tool__state">{state}</span> : null}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>

      {open ? (
        <div className="hm-tool__body" id={bodyId}>
          {item.outputRisk ? (
            <Section title={`${strings.chat.tool.riskTitle} · ${displayText(item.outputRisk.risk, 120)}`}>
              {item.outputRisk.findings.length ? (
                <ul className="hm-tool__findings">
                  {item.outputRisk.findings.map((finding, index) => (
                    <li key={index}>{displayText(finding, 600)}</li>
                  ))}
                </ul>
              ) : null}
              {item.outputRisk.redacted ? <p className="hm-tool__note">{strings.chat.tool.redacted}</p> : null}
            </Section>
          ) : null}

          {args.length > 0 ? (
            <Section title={strings.chat.tool.arguments}>
              <dl className="hm-tool__args">
                {args.map(line => (
                  <div key={line.name}>
                    <dt>
                      <bdi>{displayText(line.name, 120)}</bdi>
                    </dt>
                    <dd>
                      <Value text={line.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>
          ) : null}

          {/* A patch's diff: added and removed lines that say so to a screen reader, not only in colour. */}
          {item.inlineDiff ? (
            <div className="hm-tool__section hm-tool__diff">
              <DiffView diff={item.inlineDiff} />
            </div>
          ) : null}

          {failed ? (
            <Section title={strings.chat.tool.failed}>
              <Value text={errorText(item)} />
            </Section>
          ) : result ? (
            <Section title={strings.chat.tool.result}>
              <Value text={result} />
            </Section>
          ) : !running && !item.resultKnown ? (
            <p className="hm-tool__note">{strings.chat.tool.noResult}</p>
          ) : running && args.length === 0 && !item.inlineDiff && !item.argsText ? (
            // Nothing to show yet: say so, rather than open onto an empty box.
            <p className="hm-tool__note">{state}</p>
          ) : null}

          {item.argsText ? (
            <Section title={strings.chat.tool.rawArguments}>
              <Value text={item.argsText} />
            </Section>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export const ToolCard = memo(ToolCardView, sameRowView)
