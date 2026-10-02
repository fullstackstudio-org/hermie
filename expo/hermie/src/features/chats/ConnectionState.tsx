/**
 * The two places a chat is allowed to talk about its connection.
 *
 * Which one is on screen is `connection-notice.ts`'s decision; this file is
 * only what they look like. Both obey the same rule, and it is the rule the old
 * banner broke: **nothing about the connection is drawn at the top edge of the
 * transcript pane.** The chrome floats over that pane, so its top edge is under
 * the header pill, and a sentence put there is a sentence cut in half.
 */
import { ActivityIndicator, Pressable, View } from 'react-native'

import { Avatar } from '../../chat-ui'
import { strings } from '../../i18n/strings'
import { GlassSurface } from '../../ui/glass'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../../ui/tokens'
import type { ConnectionPhase } from './connection-notice'

/** The one status line, for either placement. */
export function connectionLabel(phase: ConnectionPhase): string {
  return strings.chat.connection[phase]
}

/**
 * A spinner is a claim that something is happening.
 *
 * `offline` is the one phase where nothing is: the radio is gone and the ladder
 * is waiting for it. Spinning there is the app pretending to work.
 */
function spins(phase: ConnectionPhase): boolean {
  return phase !== 'offline'
}

export interface ChatConnectingStateProps {
  phase: ConnectionPhase
  /** The bot's display name, under its disc. */
  name: string
  /** The profile picture, when one has been fetched; the initial otherwise. */
  avatarUri?: string
  retry: boolean
  onRetry: () => void
  /** What the connection said, when the phase word alone would mislead. */
  message?: string
  /** A second line under it, where the placement has room. */
  hint?: string
  testID?: string
}

/**
 * An empty chat that cannot be filled yet.
 *
 * Centred rather than top-aligned, and built around the BOT rather than around
 * the socket: what the reader opened is a conversation with somebody, and the
 * honest first frame of one is that person's name with a line under it saying
 * why it is still empty. The same plate carries all three phases, so nothing
 * moves when a connect becomes a reconnect.
 */
export function ChatConnectingState({
  avatarUri,
  hint = '',
  message = '',
  name,
  onRetry,
  phase,
  retry,
  testID = 'chat-connecting-state'
}: ChatConnectingStateProps) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        flex: 1,
        gap: theme.space.md,
        justifyContent: 'center',
        padding: theme.space.xl
      }}
      testID={testID}
    >
      <Avatar name={name} size={72} {...(avatarUri ? { uri: avatarUri } : {})} />

      <Text accessibilityRole="header" aria-level={1} variant="title">
        {name}
      </Text>

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        {spins(phase) ? <ActivityIndicator testID={`${testID}-activity`} /> : null}
        <Text color="textMuted" style={{ textAlign: 'center' }} variant="preview">
          {message || connectionLabel(phase)}
        </Text>
      </View>

      {/*
        The plate is the one placement with room for a second line, so the hint
        — "make sure this device is connected to that network", and only where
        that can be justified — is shown here and nowhere else.
      */}
      {hint ? (
        <Text color="textFaint" style={{ textAlign: 'center' }} testID={`${testID}-hint`} variant="meta">
          {hint}
        </Text>
      ) : null}

      {retry ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onRetry}
          style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
          testID={`${testID}-retry`}
        >
          <Text color="accentText" variant="preview">
            {strings.chat.connection.retry}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export interface ReconnectPillProps {
  phase: ConnectionPhase
  retry: boolean
  onRetry: () => void
  /**
   * What the connection said, when the phase word alone would mislead.
   *
   * No hint here. The pill is one line over a conversation somebody is reading;
   * a second sentence in it stops being a pill and starts being the banner this
   * placement exists to avoid.
   */
  message?: string
  testID?: string
}

/**
 * The same fact, for a chat that has something to read.
 *
 * A pill above the composer rather than anything in the pane, for the reason
 * the jump-to-latest pill is one: it is the only shape that can sit over a
 * conversation without being mistaken for part of it. Thin, because the reader
 * is reading and this is not what they opened the app for.
 */
export function ReconnectPill({
  message = '',
  onRetry,
  phase,
  retry,
  testID = 'chat-reconnect-pill'
}: ReconnectPillProps) {
  const theme = useTheme()

  return (
    <GlassSurface
      radius={theme.radii.pill}
      shadow="float"
      style={{ alignSelf: 'center' }}
      testID={testID}
      variant="float"
    >
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.xs + 2,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.xs + 1
        }}
      >
        {spins(phase) ? <ActivityIndicator size="small" testID={`${testID}-activity`} /> : null}

        <Text color="textMuted" style={{ flexShrink: 1 }} variant="meta">
          {message || connectionLabel(phase)}
        </Text>

        {retry ? (
          <>
            <Text color="textFaint" variant="meta">
              {'·'}
            </Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onRetry}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
              testID={`${testID}-retry`}
            >
              <Text color="accentText" style={{ fontWeight: '600' }} variant="meta">
                {strings.chat.connection.retry}
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </GlassSurface>
  )
}
