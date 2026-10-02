import * as Haptics from 'expo-haptics'

import type { HapticMoment } from './platform-contracts'
import { RUNS_ON_MAC } from './runs-on-mac'

export type { HapticMoment } from './platform-contracts'

/**
 * Fire one, and never fail because of it.
 *
 * The call is fire-and-forget on purpose: the Taptic engine is unavailable on
 * a simulator, switched off in system settings, and absent on some Android
 * builds, and none of those is a reason for a message not to send.
 *
 * ### Nothing on a Mac
 *
 * Since ADR-0011 the Mac build is this same iOS binary, so `Platform.OS` says
 * `ios` in a Mac window and every one of these calls is made there too. A Mac
 * has no Taptic engine in the machine; what it may have is a trackpad under
 * somebody's hand, and a desktop app that buzzes the trackpad when a message
 * sends is not a thing macOS does — the platform reserves haptic feedback for
 * direct manipulation the pointer is doing right now, like a Force Touch
 * alignment guide. Sending a message is not that. `expo-haptics` would most
 * likely do nothing here anyway, but "most likely nothing" is not a decision,
 * and the one place to make the decision is the seam that already exists for
 * platform differences.
 */
export function haptic(moment: HapticMoment): void {
  if (RUNS_ON_MAC) {
    return
  }

  try {
    if (moment === 'send') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)

      return
    }

    if (moment === 'choice') {
      void Haptics.selectionAsync().catch(() => undefined)

      return
    }

    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
  } catch {
    // A module that is present but has no native side throws synchronously.
  }
}
