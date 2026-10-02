/**
 * Keeping `share-targets.json` current, so the share extension can send.
 *
 * The widget snapshot's twin, and much smaller for one reason: everything a
 * share sheet decides is already decided somewhere in this app, and this only
 * copies it out. `WidgetSync` is a class with a debounce and a pause because it
 * follows eight stores and writes on every unread count; this follows two facts
 * — which bots have a resolved chat, and what language the reader is in — and
 * both change a handful of times per launch.
 *
 * ## Why `bot.canonical.id` is the right id and nothing else is
 *
 * It is the DURABLE registry id of the chat the app would open for that bot, and
 * by the time it is in the store it has already been through every decision the
 * extension must not make: `resolveCanonical` prefers the reader's own private
 * chat over the shared one, falls back to the title convention over
 * `session.list`, and fails closed rather than minting a second forever-chat.
 * `placeUserChats` then writes the private answer back over the shared one. So
 * the store holds the answer, and this writes the answer down.
 *
 * A bot whose chat has not been resolved yet has no `canonical` and is simply
 * left out: the extension then has no target for it, queues that share and the
 * app sends it. One share delivered a launch later is the correct price for
 * never guessing which conversation somebody meant.
 *
 * ## Why it is a hook and not a class
 *
 * `WidgetSync` has no React in it because it is constructed by `ChatRuntime` and
 * pushed at. This is mounted inside `ShareTargetHost`, which is already the one
 * component that exists for the whole life of the app to answer for this
 * feature — so the stores can be subscribed to directly and the effect's
 * dependency array IS the debounce: the bytes are rebuilt on every render, and
 * written only when they differ from the ones already on disk.
 */
import { useEffect, useMemo, useRef } from 'react'

import { gatewayKeyOf } from '@hermie/gateway-client'

import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { useLocale } from '../../i18n/use-locale'
import { shareInbox } from '../../platform/share-inbox'
import { useBotsStore } from '../../store/bots'
import { buildShareTargets, serialiseShareTargets, SHARE_TARGET_BOT_PLACEHOLDER } from './targets'

/**
 * Write the file whenever what it would say changes.
 *
 * Returns nothing and renders nothing. Every failure is swallowed by the seam
 * below it: a platform with no container answers false, and the consequence of
 * a file that was not written is a sheet that queues rather than sends.
 */
export function useShareTargetSync(): void {
  const bots = useBotsStore(state => state.bots)
  const { config } = useGateway()
  // Not for a value: the two sentences below are in the reader's language, and
  // a language switch has to rewrite the file that carries them.
  useLocale()

  const json = useMemo(() => {
    const targets = buildShareTargets({
      bots: bots.filter(bot => bot.canonical?.id).map(bot => ({ name: bot.name, session: bot.canonical?.id ?? '' })),
      copy: {
        sent: strings.share.sentTo(SHARE_TARGET_BOT_PLACEHOLDER),
        queued: strings.share.willSendLater,
        sending: strings.share.sending
      },
      ...(config?.baseUrl ? { gatewayKey: gatewayKeyOf(config.baseUrl) } : {}),
      now: Date.now()
    })

    return serialiseShareTargets(targets)
  }, [bots, config?.baseUrl])

  /**
   * The bytes last written, so an unchanged roster is not written again.
   *
   * `generatedAt` is inside the JSON and moves every time this recomputes, which
   * would defeat the comparison — so what is compared is the JSON with that one
   * field taken out. Written rather than remembered across launches on purpose:
   * the first write of every launch is the one that repairs a file some other
   * build left behind.
   */
  const written = useRef<string | null>(null)

  useEffect(() => {
    const comparable = json.replace(/"generatedAt":\d+,?/u, '')

    if (written.current === comparable) {
      return
    }

    written.current = comparable
    void shareInbox.writeTargets(json)
  }, [json])
}
