/**
 * How full the context window is: a ring, a percentage, and the two counts.
 *
 * ## Why a ring and not a bar
 *
 * The two places this appears are both rows in a sheet — the chat's options and
 * the bot's profile — and a row has a value on its trailing edge. A bar would
 * either span the row, which makes it the row's subject rather than its value, or
 * be a stub 40pt wide, which cannot be read at a glance. A ring is a value-sized
 * mark that is legible at 22pt, which is the size of everything else on that
 * edge.
 *
 * ## It states the numbers, not just the proportion
 *
 * "82%" is the one a reader acts on and "164k / 200k" is the one they check it
 * against, so both are on the row. `formatTokens` is deliberately coarse: a count
 * that moves in the last three digits several times a second is a row that
 * flickers while the reader is trying to read the one digit that matters.
 *
 * ## Nothing here decides whether to appear
 *
 * A caller with no reading passes nothing and draws nothing — see
 * `contextUsageOf`, where `null` is the capability gate. This component never
 * renders an empty ring, because an empty ring says the session is fresh rather
 * than saying the gateway did not answer.
 */
import type { ContextUsage } from '@hermie/transcript'
import { View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { chatStrings } from './strings'

export interface ContextMeterProps {
  usage: ContextUsage
  /** The ring's diameter. The default is what a sheet row wants. */
  size?: number
  /** Draw the counts under the percentage. Off in a tight row. */
  detail?: boolean
  testID?: string
}

/** Where the ring stops being informational and starts being a warning. */
const WARN_AT = 0.75
const DANGER_AT = 0.9

/** The ring's stroke, as a fraction of its diameter. */
const STROKE_RATIO = 0.16

/**
 * A token count a reader can hold in their head.
 *
 * Thousands past a thousand and millions past a million, one decimal only where
 * it changes the reading — `1.2M` says something `1M` does not, while `164.2k`
 * and `164k` do not differ in any way that matters at a glance.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(Math.round(tokens))
  }

  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}k`
  }

  const millions = tokens / 1_000_000

  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`
}

/** `164k / 200k`, which is the line under the percentage. */
export function formatContextCounts(usage: ContextUsage): string {
  return chatStrings.context.counts(formatTokens(usage.used), formatTokens(usage.limit))
}

export function ContextMeter({ usage, size = 22, detail = false, testID = 'context-meter' }: ContextMeterProps) {
  const theme = useTheme()
  const stroke = Math.max(2, Math.round(size * STROKE_RATIO))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius

  // Three steps rather than a gradient: the reader is making a decision — is
  // there room for another long turn — and a colour that slides continuously
  // never actually says which side of it they are on.
  const tint =
    usage.fraction >= DANGER_AT
      ? theme.colors.dangerText
      : usage.fraction >= WARN_AT
        ? theme.colors.warnText
        : theme.colors.accentText

  return (
    <View style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }} testID={testID}>
      <View style={{ alignItems: 'flex-end' }}>
        <Text variant="meta">{chatStrings.context.percent(usage.percent)}</Text>
        {detail ? (
          <Text color="textMuted" variant="meta">
            {formatContextCounts(usage)}
          </Text>
        ) : null}
      </View>

      <Svg
        // The ring repeats what the percentage beside it already says, so it
        // carries no accessibility value of its own — the same rule `Ticks`
        // follows, and `ui/Icon.tsx` says why all three props are needed.
        accessibilityElementsHidden
        aria-hidden
        height={size}
        importantForAccessibility="no-hide-descendants"
        width={size}
      >
        <Circle cx={size / 2} cy={size / 2} fill="none" r={radius} stroke={theme.tintSunk} strokeWidth={stroke} />
        {/*
          Rotated so the arc starts at twelve o'clock, which is where every
          other progress ring on these platforms starts. `strokeDashoffset` is
          the remainder rather than the fill, because a dash array draws from
          the path's own origin.
        */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          origin={`${size / 2}, ${size / 2}`}
          r={radius}
          rotation={-90}
          stroke={tint}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - usage.fraction)}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </Svg>
    </View>
  )
}

/**
 * The whole row's value as one string, for a surface that draws no ring.
 *
 * The bot profile's About group is a column of `label / value` rows and a ring
 * in one of them would be the only drawing in the sheet. It says the same thing
 * in the same words instead — and adds the caveat the ring cannot carry, because
 * a gateway that flags its own count as an estimate has said something a reader
 * checking whether a long turn will fit needs to know.
 */
export function contextSummary(usage: ContextUsage): string {
  const base = `${chatStrings.context.percent(usage.percent)} · ${formatContextCounts(usage)}`

  return usage.estimated ? `${base} ${chatStrings.context.estimated}` : base
}
