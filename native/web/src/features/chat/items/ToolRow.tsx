/**
 * A tool call: one collapsed line, and its detail as plain text when opened.
 *
 * The line is a button (`aria-expanded`): the tool's name, what it did, how long
 * it took or that it is still running. Opened, it shows the arguments, what came
 * back, the raw text the gateway sends at its verbose setting, and a warning
 * when the output was flagged as untrusted: all of it as characters in a
 * `pre`-style block, never Markdown, because none of it was written for a reader.
 *
 * A tool whose interface is somewhere else (`todo`, a reaction) draws nothing
 * while it succeeds, and does draw when it fails, because a failure nobody can
 * see is the worst of both. At the verbose level the selectors hand the row over
 * as `full` and it starts opened; one click pins it either way.
 */
import type { ToolItem } from '@hermie/transcript'
import { memo, type ReactNode, useId, useState } from 'react'

import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { Icon } from '../../../ui/icons'
import { formatDuration } from '../chat-format'
import { type RowViewProps, sameRowView } from './row-view'
import { argumentLines, errorText, isSilentTool, LONG_VALUE_CHARS, resultText, toolSummary } from './tool-text'

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

function ToolRowView({ item, presentation }: RowViewProps<ToolItem>) {
  useLocale()

  const bodyId = useId()
  // `null` is "the reader has not decided": a verbosity change still opens and closes the row.
  const [chosen, setChosen] = useState<boolean | null>(null)

  const failed = Boolean(item.isError) || item.status === 'error'

  if (presentation === 'hidden-placeholder' || (isSilentTool(item.name) && !failed)) {
    return null
  }

  const open = chosen ?? presentation === 'full'
  const running = item.status === 'running' || item.status === 'generating'
  const duration = formatDuration(item.durationS)
  const summary = toolSummary(item)
  const args = argumentLines(item.args)
  const result = item.resultKnown ? resultText(item) : ''
  // A patch's diff first, as the text it is (the diff view is W-18b's); then what the tool answered.
  const shown = [item.inlineDiff, result].filter(Boolean).join('\n\n')
  const state = running
    ? item.status === 'generating'
      ? strings.chat.tool.generating
      : strings.chat.tool.running
    : failed
      ? strings.chat.tool.failed
      : duration

  return (
    <article className="hm-tool" data-failed={failed ? 'true' : 'false'} data-running={running ? 'true' : 'false'}>
      <button
        className="hm-tool__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setChosen(!open)}
      >
        <span className="hm-tool__name">{item.name}</span>
        {summary ? <span className="hm-tool__summary">{summary}</span> : null}
        {state ? <span className="hm-tool__state">{state}</span> : null}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>

      {open ? (
        <div className="hm-tool__body" id={bodyId}>
          {item.outputRisk ? (
            <Section title={`${strings.chat.tool.riskTitle} · ${item.outputRisk.risk}`}>
              {item.outputRisk.findings.length ? (
                <ul className="hm-tool__findings">
                  {item.outputRisk.findings.map((finding, index) => (
                    <li key={index}>{finding}</li>
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
                    <dt>{line.name}</dt>
                    <dd>
                      <Value text={line.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>
          ) : null}

          {failed ? (
            <Section title={strings.chat.tool.failed}>
              <Value text={errorText(item)} />
            </Section>
          ) : shown ? (
            <Section title={strings.chat.tool.result}>
              <Value text={shown} />
            </Section>
          ) : !running && !item.resultKnown ? (
            <p className="hm-tool__note">{strings.chat.tool.noResult}</p>
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

export const ToolRow = memo(ToolRowView, sameRowView)
