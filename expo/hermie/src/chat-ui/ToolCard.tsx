/**
 * A tool call, as an attachment-style card in the transcript.
 *
 * Collapsed it is one line: family glyph, name, what it did, how long it took.
 * Expanded it shows arguments, the humanised result, a diff when the call
 * produced one, and the raw `args_text`/`result_text` the gateway only sends at
 * `display.tool_progress verbose`.
 *
 * Silent tools (`todo`, `react_to_message`) render NOTHING while they succeed —
 * their UI is somewhere else entirely — but they do render when they fail,
 * because a failure nobody can see is the worst of both.
 *
 * ## The inline answer
 *
 * ADR-0010 keeps the sheet: a question the agent is BLOCKED on has to arrive in
 * front of the reader rather than wait somewhere in a scrolled-away transcript.
 * What the sheet cannot do is answer the reader who has already scrolled to the
 * card, read the arguments, and knows what they want — for them the sheet is a
 * second surface asking a question they have finished thinking about.
 *
 * So `approval` draws the server's choices ON the card, in the server's order,
 * with the same rule the sheet follows: the buttons are exactly `choices` and
 * never a set this component invented. One tap answers, and because both
 * surfaces read the same request store the sheet goes down with it.
 *
 * It is a PROP rather than a lookup, and that is the honest shape: the gateway's
 * approval carries a tool NAME and no tool-call id (see docs/platform-notes.md),
 * so only the host can decide which card a question belongs to, and only the
 * host can decline to decide when two calls share a name.
 */
import { useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'

import { MONOSPACE } from '../markdown'
import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Icon, ICON_SIZE } from '../ui/Icon'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../ui/tokens'
import { DiffView } from './DiffView'
import { clipInline, formatDuration } from './format'
import { chatStrings } from './strings'
import { argumentRows, extractToolErrorMessage, formatToolResultSummary } from './tool-result-summary'
import { isSilentTool, toolFamily, toolGlyph } from './tool-render-class'
import { useLedgerWidth } from './primitives/Bubble'
import type { Presentation, ToolItem } from './types'

/**
 * A question waiting on this card, as the little the card needs to draw it.
 *
 * Not the `ApprovalItem`: the card has no business knowing about request ids or
 * about the queue, and a shape this small is one a test can state in a line.
 */
export interface InlineApproval {
  /** Exactly the server's `choices`, in the server's order. Never invented. */
  choices: readonly string[]
  /** `choice` is one of `choices`, verbatim. */
  onRespond: (choice: string) => void
}

/** `always` → "Always allow"; an unknown choice keeps its own name. */
function choiceLabel(choice: string): string {
  return chatStrings.approval.choices[choice] ?? choice.replace(/_/gu, ' ')
}

function choiceVariant(choice: string): 'primary' | 'secondary' | 'danger' {
  if (choice === 'deny') {
    return 'danger'
  }

  return choice === 'once' ? 'primary' : 'secondary'
}

export interface ToolCardProps {
  item: ToolItem
  presentation?: Presentation
  /** Controlled disclosure; omit to let the card manage its own. */
  expanded?: boolean
  onToggleExpanded?: (expanded: boolean) => void
  /**
   * An open question about THIS call, answerable here.
   *
   * Absent for every card the host has not linked to a question, which is all
   * of them most of the time. See the note at the top about why the host
   * decides and not the card.
   */
  approval?: InlineApproval
}

const LONG_VALUE_CHARS = 280

function SectionLabel({ children }: { children: string }) {
  const theme = useTheme()

  return (
    <Text color="textMuted" style={{ fontSize: 11, letterSpacing: 0.6, marginTop: theme.space.sm }}>
      {children.toUpperCase()}
    </Text>
  )
}

function Truncatable({ value, testID }: { value: string; testID?: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const long = value.length > LONG_VALUE_CHARS

  return (
    <View>
      <Text
        selectable
        style={{ color: theme.colors.text, fontFamily: MONOSPACE, fontSize: 12, lineHeight: 18 }}
        testID={testID}
      >
        {long && !open ? `${value.slice(0, LONG_VALUE_CHARS)}…` : value}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={open}
          hitSlop={TAP_SLOP}
          onPress={() => setOpen(current => !current)}
          style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
        >
          <Text color="accentText" variant="meta">
            {open ? chatStrings.tool.showLess : chatStrings.tool.showMore}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function oneLineSummary(item: ToolItem): string {
  if (item.summary?.trim()) {
    return clipInline(item.summary, 90)
  }

  if (item.status === 'running') {
    return chatStrings.tool.running
  }

  if (item.status === 'generating') {
    return chatStrings.tool.generating
  }

  if (item.context?.trim()) {
    return clipInline(item.context, 90)
  }

  if (item.resultKnown && item.result !== undefined) {
    return clipInline(formatToolResultSummary(item.result), 90)
  }

  return ''
}

export function ToolCard({ item, presentation = 'collapsed', expanded, onToggleExpanded, approval }: ToolCardProps) {
  const theme = useTheme()
  const maxWidth = useLedgerWidth()
  // `null` means "the user has not decided", so a verbosity change still opens
  // or closes the card; one tap pins it and verbosity stops overriding it.
  const [selfExpanded, setSelfExpanded] = useState<boolean | null>(null)
  const isExpanded = expanded ?? selfExpanded ?? presentation === 'full'

  const failed = Boolean(item.isError) || item.status === 'error'

  if (isSilentTool(item.name) && !failed) {
    return null
  }

  if (presentation === 'hidden-placeholder') {
    // Quiet mode keeps one "working" row standing in for the whole tool
    // stream; the row belongs to the list, not to this card.
    return null
  }

  const running = item.status === 'running' || item.status === 'generating'
  const family = toolFamily(item.name)
  const duration = formatDuration(item.durationS)
  const errorText = failed ? extractToolErrorMessage(item.result) || item.summary || chatStrings.tool.failed : ''
  const resultSummary = item.resultKnown && item.result !== undefined ? formatToolResultSummary(item.result) : ''
  const rows = argumentRows(item.args)
  const summaryLine = oneLineSummary(item)

  const toggle = () => {
    const next = !isExpanded

    setSelfExpanded(next)
    onToggleExpanded?.(next)
  }

  return (
    <View
      style={{
        backgroundColor: theme.elevation.e3c,
        borderLeftColor: failed ? theme.colors.danger : 'transparent',
        borderLeftWidth: failed ? 3 : 0,
        borderRadius: theme.radii.xl,
        // Inside a transcript the cap is the bubble's; the margin is what keeps
        // a card off the gutter on a column narrow enough for the cap to be the
        // whole of it.
        marginRight: 26,
        marginVertical: theme.space.md,
        maxWidth,
        overflow: 'hidden'
      }}
      testID={`tool-card-${item.id}`}
    >
      <Pressable
        accessibilityLabel={`${item.name}. ${summaryLine}`}
        accessibilityRole="button"
        aria-expanded={isExpanded}
        onPress={toggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        testID={`tool-toggle-${item.id}`}
      >
        <View
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            gap: theme.space.sm,
            padding: theme.space.md
          }}
        >
          <Text color={failed ? 'dangerText' : 'textMuted'} style={{ fontSize: 15, width: 22 }}>
            {failed ? '!' : toolGlyph(family)}
          </Text>

          <View style={{ flex: 1, gap: 2 }}>
            <Text color={failed ? 'dangerText' : 'text'} style={{ fontSize: 14, fontWeight: '600' }}>
              {item.name}
            </Text>
            {summaryLine ? (
              <Text color="textMuted" numberOfLines={1} style={{ fontSize: 12 }}>
                {summaryLine}
              </Text>
            ) : null}
          </View>

          {running ? <ActivityIndicator color={theme.colors.textMuted} size="small" /> : null}

          {duration && !running ? (
            <Text color="textMuted" style={{ fontSize: 12 }}>
              {duration}
            </Text>
          ) : null}

          <Icon
            color={theme.colors.textMuted}
            name={isExpanded ? 'chevronDown' : 'chevronRight'}
            size={ICON_SIZE.inline}
          />
        </View>
      </Pressable>

      {/*
        Above the body, not inside it.

        A collapsed card is one line, and a question folded away inside a
        disclosure the reader has to open first is a question that is not being
        asked. It sits under the summary row either way, which is where the eye
        already is.
      */}
      {approval ? (
        <View
          style={{
            borderTopColor: theme.hairline,
            borderTopWidth: 1,
            gap: theme.space.sm,
            padding: theme.space.md
          }}
          testID={`tool-approval-${item.id}`}
        >
          <Text color="textMuted" variant="meta">
            {chatStrings.approval.title}
          </Text>
          {approval.choices.map(choice => (
            <Button
              key={choice}
              onPress={() => approval.onRespond(choice)}
              testID={`tool-approval-${item.id}-${choice}`}
              title={choiceLabel(choice)}
              variant={choiceVariant(choice)}
            />
          ))}
        </View>
      ) : null}

      {isExpanded ? (
        <View
          style={{
            borderTopColor: theme.hairline,
            borderTopWidth: 1,
            padding: theme.space.md,
            paddingTop: theme.space.xs
          }}
          testID={`tool-body-${item.id}`}
        >
          {item.outputRisk ? (
            <View
              style={{
                backgroundColor: theme.elevation.e3c,
                borderColor: theme.colors.danger,
                borderRadius: theme.radii.md,
                borderWidth: 1,
                gap: 2,
                marginTop: theme.space.sm,
                padding: theme.space.sm
              }}
              testID={`tool-risk-${item.id}`}
            >
              <Text color="dangerText" style={{ fontSize: 12, fontWeight: '600' }}>
                {`${chatStrings.tool.riskTitle} · ${item.outputRisk.risk}`}
              </Text>
              {item.outputRisk.findings.map((finding, index) => (
                <Text color="textMuted" key={index} style={{ fontSize: 12 }}>
                  {`• ${finding}`}
                </Text>
              ))}
              {item.outputRisk.redacted ? (
                <Text color="textMuted" style={{ fontSize: 11 }}>
                  {chatStrings.tool.redacted}
                </Text>
              ) : null}
            </View>
          ) : null}

          {rows.length ? (
            <>
              <SectionLabel>{chatStrings.tool.arguments}</SectionLabel>
              {rows.map(row => (
                <View key={row.key} style={{ marginTop: theme.space.xs }}>
                  <Text color="textMuted" style={{ fontSize: 11 }}>
                    {row.key}
                  </Text>
                  <Truncatable testID={`tool-arg-${item.id}-${row.key}`} value={row.value} />
                </View>
              ))}
            </>
          ) : null}

          {item.inlineDiff ? <DiffView diff={item.inlineDiff} testID={`tool-diff-${item.id}`} /> : null}

          {failed ? (
            <>
              <SectionLabel>{chatStrings.tool.failed}</SectionLabel>
              <Text color="dangerText" selectable style={{ fontSize: 13, lineHeight: 19 }}>
                {errorText}
              </Text>
            </>
          ) : null}

          {!failed && resultSummary ? (
            <>
              <SectionLabel>{chatStrings.tool.result}</SectionLabel>
              <Text color="text" selectable style={{ fontSize: 13, lineHeight: 19 }}>
                {resultSummary}
              </Text>
            </>
          ) : null}

          {!failed && !resultSummary && !item.resultKnown && !running ? (
            <Text color="textMuted" style={{ fontSize: 12, marginTop: theme.space.sm }}>
              {chatStrings.tool.noResult}
            </Text>
          ) : null}

          {item.argsText ? (
            <>
              <SectionLabel>{chatStrings.tool.rawArguments}</SectionLabel>
              <Truncatable testID={`tool-args-text-${item.id}`} value={item.argsText} />
            </>
          ) : null}

          {item.resultText ? (
            <>
              <SectionLabel>{chatStrings.tool.rawResult}</SectionLabel>
              <Truncatable testID={`tool-result-text-${item.id}`} value={item.resultText} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
