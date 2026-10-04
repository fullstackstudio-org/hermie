/**
 * What each push type is called on a screen: the catalogue's words, which the
 * native apps say too. Settings › Notifications and the chat's options both list
 * the seven types of `contract/push/contract.json` with these.
 */
import type { PushType } from '@hermie/gateway-client/push'

import { strings } from '../../generated/strings'

export function pushTypeLabel(type: PushType): string {
  const words = strings.app.settings.notifications

  switch (type) {
    case 'message':
      return words.typeMessage
    case 'request':
      return words.typeRequest
    case 'cron':
      return words.typeCron
    case 'cron_done':
      return words.typeCronDone
    case 'cron_failed':
      return words.typeCronFailed
    case 'turn_done':
      return words.typeTurnDone
    case 'turn_failed':
      return words.typeTurnFailed
  }
}
