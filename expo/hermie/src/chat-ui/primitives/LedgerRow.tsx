/**
 * A quiet ledger row: the silhouette every machine event in the transcript
 * shares.
 *
 * §6.4 — tool calls, thinking, cron deliveries and outgoing bot-to-bot messages
 * are never bubbles. They read as a ledger in the bot's gutter: the same left edge
 * as an incoming bubble, a distinctly different shape. Collapsed it is one line
 * you can skim past; expanded content sits on a glass card BELOW the line, which
 * is what keeps the expensive part (code, diffs, tables) unmounted until asked
 * for (§7.4).
 *
 * The row itself is not glass and has no blur. It is a hairline, a glyph well and
 * type — a hundred of these scroll, and a hundred blur views do not.
 *
 * Inside a transcript it also takes the bubble's width cap (`useLedgerWidth`):
 * "same left edge" is only half a silhouette if the right one is the window.
 * Elsewhere — the Activity timeline draws these too — there is no column and no
 * cap, and the row fills what it is given.
 */
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'

import { MONOSPACE } from '../../markdown'
import { GlassSurface } from '../../ui/glass'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { TAP_SLOP, type TextColorRole } from '../../ui/tokens'
import { useLedgerWidth } from './Bubble'

export interface LedgerRowProps {
  /** One character, in the glyph well. Machine events all carry one. */
  glyph: string
  /** The label: `terminal`, `Thought for 8s`, `CRON`. */
  title: string
  /** Monospace where it is machine text — a command, a path, an argument. */
  detail?: string
  detailMono?: boolean
  /** Right-hand side: a duration, a count, a status word. */
  trailing?: string
  tone?: 'neutral' | 'danger' | 'ok' | 'accent'
  /** Present makes the row a disclosure. */
  onToggle?: () => void
  expanded?: boolean
  /** Rendered on a glass card under the row, only while expanded. */
  children?: ReactNode
  accessibilityLabel?: string
  testID?: string
}

const TONE_INK: Record<NonNullable<LedgerRowProps['tone']>, TextColorRole> = {
  neutral: 'textMuted',
  danger: 'dangerText',
  ok: 'okText',
  accent: 'accentText'
}

export function LedgerRow({
  glyph,
  title,
  detail,
  detailMono = false,
  trailing,
  tone = 'neutral',
  onToggle,
  expanded = false,
  children,
  accessibilityLabel,
  testID
}: LedgerRowProps) {
  const theme = useTheme()
  const ink = TONE_INK[tone]
  const maxWidth = useLedgerWidth()

  const line = (
    <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, minHeight: 28 }}>
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.tintSunk,
          borderRadius: theme.radii.sm + 2,
          height: 20,
          justifyContent: 'center',
          width: 20
        }}
      >
        <Text color={ink} style={{ fontSize: 11, lineHeight: 14 }}>
          {glyph}
        </Text>
      </View>

      <Text color={ink} numberOfLines={1} style={{ flexShrink: 0 }} variant="meta">
        {title}
      </Text>

      {detail ? (
        <Text
          color="textFaint"
          numberOfLines={1}
          style={{ flexShrink: 1, ...(detailMono ? { fontFamily: MONOSPACE } : {}) }}
          variant={detailMono ? 'code' : 'meta'}
        >
          {detail}
        </Text>
      ) : null}

      <View style={{ flex: 1 }} />

      {trailing ? (
        <Text color="textFaint" variant="meta">
          {trailing}
        </Text>
      ) : null}

      {onToggle ? (
        <Icon color={theme.colors.textFaint} name={expanded ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.marker} />
      ) : null}
    </View>
  )

  return (
    <View style={{ gap: theme.space.xs, maxWidth }} testID={testID}>
      {onToggle ? (
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          aria-expanded={expanded}
          hitSlop={TAP_SLOP}
          onPress={onToggle}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          {line}
        </Pressable>
      ) : (
        line
      )}

      {expanded && children ? (
        <GlassSurface
          contentStyle={{ gap: theme.space.sm, padding: theme.space.md }}
          testID={testID ? `${testID}-card` : undefined}
          variant="card"
        >
          {children}
        </GlassSurface>
      ) : null}
    </View>
  )
}
