/**
 * One `delegate_task` fan-out: the goals that were handed out, a status glyph
 * per child, and the completion summary once they all land.
 *
 * The children live in `ChatState.subagents` rather than on the item, so the
 * caller passes the ones that belong to this group.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import type { TextColorRole } from '../ui/tokens'
import { Chip } from './primitives/Chip'
import { useLedgerWidth } from './primitives/Bubble'
import { clipInline, formatDuration } from './format'
import { chatStrings } from './strings'
import type { Presentation, Subagent, SubagentGroupItem, SubagentStatus } from './types'

export interface SubagentGroupCardProps {
  item: SubagentGroupItem
  /** The children of this fan-out, in the order they should read. */
  subagents?: Subagent[]
  presentation?: Presentation
  onOpenTranscript?: (subagentId: string) => void
}

export function statusGlyph(status: SubagentStatus): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'failed':
      return '✕'
    case 'interrupted':
      return '■'
    case 'running':
      return '●'
    default:
      return '○'
  }
}

/**
 * The ink a subagent's status word is drawn in.
 *
 * Every arm is a FLOORED role. `ok` and `accent` are fills — a status dot, a send
 * button — and two of these used to name one, which put a status word on a card
 * at whatever ratio the swatch happened to land on. See `TextColorRole`.
 */
export function statusTone(status: SubagentStatus): TextColorRole {
  switch (status) {
    case 'completed':
      return 'okText'
    case 'failed':
      return 'dangerText'
    case 'running':
      return 'accentText'
    default:
      return 'textMuted'
  }
}

export function SubagentGroupCard({
  item,
  subagents = [],
  presentation = 'collapsed',
  onOpenTranscript
}: SubagentGroupCardProps) {
  const theme = useTheme()
  const maxWidth = useLedgerWidth()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const title = `${chatStrings.subagents.title} · ${chatStrings.subagents.groupStatus[item.status]}`

  if (presentation === 'chip') {
    return <Chip centered label={`${title} · ${chatStrings.subagents.goals(item.goals.length)}`} />
  }

  const detailed = presentation === 'full'
  const openable = subagents.filter(child => child.childSessionId)

  return (
    <View
      style={{
        backgroundColor: theme.elevation.e3c,
        borderRadius: theme.radii.xl,
        gap: theme.space.xs,
        marginRight: 26,
        marginVertical: theme.space.md,
        maxWidth,
        padding: theme.space.md
      }}
      testID={`subagent-group-${item.id}`}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Text style={{ color: theme.colors.text, flex: 1, fontSize: 14, fontWeight: '600' }}>{title}</Text>
        <Text color="textMuted" style={{ fontSize: 12 }}>
          {chatStrings.subagents.goals(item.goals.length)}
        </Text>
      </View>

      {item.goals.map((goal, index) => {
        const child = subagents[index]

        return (
          <View key={index} style={{ flexDirection: 'row', gap: theme.space.sm }}>
            <Text color={child ? statusTone(child.status) : 'textMuted'} style={{ fontSize: 12, width: 14 }}>
              {statusGlyph(child?.status ?? 'queued')}
            </Text>
            <Text
              color="text"
              numberOfLines={detailed ? undefined : 1}
              style={{ flex: 1, fontSize: 13, lineHeight: 19 }}
            >
              {goal}
            </Text>
            {child?.durationSeconds ? (
              <Text color="textMuted" style={{ fontSize: 11 }}>
                {formatDuration(child.durationSeconds)}
              </Text>
            ) : null}
          </View>
        )
      })}

      {item.completion ? (
        <Text color="textMuted" selectable style={{ fontSize: 13, lineHeight: 19, marginTop: theme.space.xs }}>
          {item.completion}
        </Text>
      ) : null}

      {/* Only children that actually have a transcript to open, and each chip
          names its own goal — three chips all reading "Open transcript" tell
          the reader nothing about which one they are about to open. */}
      {detailed && onOpenTranscript && openable.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs, marginTop: theme.space.xs }}>
          {openable.map(child => (
            <Chip
              key={child.id}
              label={clipInline(child.goal, 28)}
              onPress={() => onOpenTranscript(child.id)}
              testID={`subagent-open-${child.id}`}
              tone="accentText"
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}
