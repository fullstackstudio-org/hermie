/**
 * The wired half of the share picker.
 *
 * Mounted once, by `ChatRuntime`, rather than by a shell — for the same reason
 * `PushSync` lives there: there are two shells, only one of them is on screen,
 * and a sheet duplicated in both would be two `Modal`s racing to present the
 * same question.
 *
 * The delivery flow is handed over as a PROP rather than read back out of the
 * runtime context, and that is not style. `ChatRuntime` builds this component's
 * data, so a component that reached back into the runtime to find it would
 * close an import cycle through `features/chats` — the kind that resolves to
 * `undefined` at module scope in a release bundle and to nothing at all in
 * development, which is the worst pair of symptoms to debug.
 *
 * It answers one entry at a time, oldest first. Somebody who shared three
 * things to Hermie in a row is answering three questions, and three stacked
 * sheets is not how anyone would like to be asked.
 *
 * It also keeps `share-targets.json` current, which is the file that lets the iOS
 * share extension deliver without opening the app at all (ADR-0026). That is a
 * second job for one component and it is deliberate: both are "the app's side of
 * sharing, for as long as the app is alive", and there is nowhere else that is
 * mounted exactly once and never unmounted.
 */
import { useEffect, useMemo, useState } from 'react'

import { botLabel } from '../../store/bot-names'
import { useBotsStore } from '../../store/bots'
import { useSettingsStore } from '../../store/settings'
import { useUnassignedShare } from '../../store/share'
import type { ShareDelivery } from './share-delivery'
import { ShareTargetSheet, type ShareTargetBot } from './ShareTargetSheet'
import { useShareTargetSync } from './target-sync'

export function ShareTargetHost({ share: delivery }: { share: ShareDelivery }) {
  const share = useUnassignedShare()
  const bots = useBotsStore(state => state.bots)

  /*
    The file the iOS share extension needs in order to send something itself.

    Here, and not in a shell, for the same two reasons this component is here:
    it is mounted exactly once and it is mounted for the whole life of the app.
    A sync in both shells would write the file twice on every roster change, and
    a sync inside a screen would stop writing the moment somebody navigated —
    which would be a share sheet quietly falling back to queueing, with nothing
    on screen to say why.
  */
  useShareTargetSync()

  /**
   * The entry the sheet is SHOWING, which outlives the one that is waiting.
   *
   * Two things need this and only one of them is cosmetic. The cosmetic one is
   * the slide-out: an entry that leaves the queue the instant "Send" is tapped
   * would unmount the sheet mid-animation. The other is that this component is
   * mounted for the whole life of the app, beside the chat runtime — and
   * `BottomSheet` reads the safe-area inset the moment it renders, whether or
   * not it is visible. Rendering nothing until there is something to ask about
   * keeps a `Modal`, a `PanResponder` and a safe-area subscription out of every
   * launch that never sees a share.
   */
  const [shown, setShown] = useState<typeof share>(undefined)

  useEffect(() => {
    if (share) {
      setShown(share)
    }
  }, [share])
  const avatars = useBotsStore(state => state.avatars)
  const order = useSettingsStore(state => state.botNameOrder)
  const hideHandle = useSettingsStore(state => state.hideHandleWhenNamed)

  /**
   * Most recently active first, which is the widget snapshot's order and for
   * the same reason: a picker is a glance, and the only ordering worth spending
   * a glance on is "what happened last". The arrangement the reader made in the
   * chat list is deliberately not used — a folder means nothing to a question
   * about one destination.
   */
  const choices = useMemo<ShareTargetBot[]>(
    () =>
      [...bots]
        .sort(
          (left, right) =>
            (right.canonical?.lastActive ?? 0) - (left.canonical?.lastActive ?? 0) ||
            left.name.localeCompare(right.name)
        )
        .map(bot => ({
          name: bot.name,
          label: botLabel(bot, order, { hideHandle }),
          ...(avatars[bot.name] ? { avatarUri: avatars[bot.name] } : {})
        })),
    [avatars, bots, hideHandle, order]
  )

  if (!shown) {
    return null
  }

  return (
    <ShareTargetSheet
      bots={choices}
      onCancel={() => void delivery.discard(shown.id)}
      // The sheet has finished sliding out. Only now is the mount dropped, and
      // only when nothing else has arrived in the meantime — somebody who shared
      // three things in a row is answering three questions, one after another.
      onClosed={() => setShown(share)}
      onSend={(bot, note) => void delivery.assign(shown.id, bot, note)}
      {...(share ? { share } : {})}
    />
  )
}
