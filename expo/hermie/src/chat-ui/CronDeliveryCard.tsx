/**
 * A cron delivery, as its own card.
 *
 * §6.5. A scheduled job's report used to render as the OWNER'S OWN blue bubble
 * with raw markdown in it — the gateway injects the delivery as a real inbound
 * turn, so it persists as a `role:user` row and the transcript believed it. It is
 * not the owner speaking and it is not speech: it is a machine event, and §6.4
 * says machine events are never bubbles.
 *
 * Collapsed it is a clock glyph, the job's name and `ran 04:22 · delivered to this
 * chat`. Expanded it is the body as rendered markdown, plus the two things a
 * reader wants next: the cron itself, and running it again.
 *
 * The props are deliberately plain values rather than the transcript item: which
 * fields the projection carries is `packages/transcript`'s business, and a card
 * that takes a name and a body can be rendered from a literal in the gallery.
 */
import { Pressable, View } from 'react-native'

import { Markdown } from '../markdown'
import { GlassSurface } from '../ui/glass'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Icon, ICON_SIZE } from '../ui/Icon'
import { TAP_SLOP } from '../ui/tokens'
import { formatClock } from './format'
import { useLedgerWidth } from './primitives/Bubble'
import { chatStrings } from './strings'

export interface CronDeliveryCardProps {
  /** The job's name, as the gateway wrote it into the header. */
  name: string
  body: string
  /** When the delivery landed, in unix seconds. */
  ts?: number
  expanded: boolean
  onToggle: () => void
  /** Offered only where the caller can actually open the cron. */
  onOpenCron?: () => void
  onRunNow?: () => void
  onLinkPress?: (href: string) => void
  testID?: string
}

export function CronDeliveryCard({
  name,
  body,
  ts,
  expanded,
  onToggle,
  onOpenCron,
  onRunNow,
  onLinkPress,
  testID
}: CronDeliveryCardProps) {
  const theme = useTheme()
  const maxWidth = useLedgerWidth()
  const time = formatClock(ts)

  return (
    <GlassSurface contentStyle={{ padding: theme.space.md }} style={{ maxWidth }} testID={testID} variant="card">
      <Pressable
        accessibilityRole="button"
        aria-expanded={expanded}
        hitSlop={TAP_SLOP}
        onPress={onToggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <View style={{ alignItems: 'flex-start', flexDirection: 'row', gap: theme.space.sm }}>
          <View
            style={{
              alignItems: 'center',
              backgroundColor: theme.tintSunk,
              borderRadius: theme.radii.sm + 2,
              height: 22,
              justifyContent: 'center',
              width: 22
            }}
          >
            <Text color="textMuted" style={{ fontSize: 12, lineHeight: 15 }}>
              {'◴'}
            </Text>
          </View>

          <View style={{ flex: 1, gap: 1 }}>
            <Text color="textFaint" variant="micro">
              {chatStrings.cron.eyebrow}
            </Text>
            <Text numberOfLines={2} variant="name">
              {name}
            </Text>
            <Text color="textFaint" variant="meta">
              {time ? chatStrings.cron.ranAt(time) : chatStrings.cron.delivered}
            </Text>
          </View>

          <Icon
            color={theme.colors.textFaint}
            name={expanded ? 'chevronDown' : 'chevronRight'}
            size={ICON_SIZE.marker}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View style={{ gap: theme.space.md, marginTop: theme.space.md }} testID={testID ? `${testID}-body` : undefined}>
          {body.trim() ? (
            <Markdown
              fontSize={theme.type.preview.fontSize}
              linkColor={theme.accent().text}
              onLinkPress={onLinkPress}
              text={body}
            />
          ) : (
            <Text color="textFaint" variant="meta">
              {chatStrings.cron.emptyBody}
            </Text>
          )}

          {onOpenCron || onRunNow ? (
            <View style={{ flexDirection: 'row', gap: theme.space.lg }}>
              {onOpenCron ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={TAP_SLOP}
                  onPress={onOpenCron}
                  testID={testID ? `${testID}-open` : undefined}
                >
                  <Text color="accentText" variant="meta">
                    {chatStrings.cron.open}
                  </Text>
                </Pressable>
              ) : null}

              {onRunNow ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={TAP_SLOP}
                  onPress={onRunNow}
                  testID={testID ? `${testID}-run` : undefined}
                >
                  <Text color="accentText" variant="meta">
                    {chatStrings.cron.runNow}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </GlassSurface>
  )
}
