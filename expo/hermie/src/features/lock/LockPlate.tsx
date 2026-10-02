/**
 * What a locked Hermie looks like: the app's name, one button, and nothing
 * else.
 *
 * The emptiness is the feature. A lock screen that shows how many chats are
 * waiting, or who the last message was from, has given away the thing it was
 * put there to hold — so this component is deliberately incapable of it. It
 * takes no props about the app's contents, and the gate above it does not
 * render the app at all while it is up, so there is nothing underneath to leak
 * through a blur.
 *
 * **Notification previews are not this component's business.** What a banner
 * says on a locked phone is decided by the operating system and by the
 * notification's own payload, both outside this process. ADR-0017 is where that
 * payload is settled.
 */
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { GlassSurface } from '../../ui/glass'
import { Button, Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export interface LockPlateProps {
  onUnlock: () => void
  /** True while the platform's own prompt is up; the button waits rather than stacking prompts. */
  busy?: boolean
  /**
   * Said under the button when the device has nothing left to unlock with.
   *
   * The only way into that state is a passcode removed after the lock was
   * switched on — `changeThreshold` refuses to switch it on otherwise — and it
   * is the one case where the plate has to explain itself rather than just ask.
   */
  stranded?: boolean
}

export function LockPlate({ onUnlock, busy = false, stranded = false }: LockPlateProps) {
  const theme = useTheme()

  return (
    <Screen testID="lock-plate">
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <GlassSurface
          contentStyle={{
            alignItems: 'center',
            gap: theme.space.lg,
            paddingHorizontal: theme.space.xl,
            paddingVertical: theme.space.xxl
          }}
          opaque
          shadow="float"
          style={{ width: '100%', maxWidth: 340 }}
          variant="panel"
        >
          <Text variant="chatName">{strings.app.name}</Text>
          <Text color="textMuted" style={{ textAlign: 'center' }}>
            {stranded ? strings.lock.stranded : strings.lock.plateBody}
          </Text>
          <Button busy={busy} onPress={onUnlock} testID="lock-unlock" title={strings.lock.unlock} />
        </GlassSurface>
      </View>
    </Screen>
  )
}
