/**
 * A chat's line about a form, a file request or a draft that ended without the reader's answer (it expired, the bot
 * stopped asking, another device answered it, it ended while the connection was down, the answer may not have
 * arrived), or that this page could not show and said so to the gateway (`4041`). Never a row of the transcript (the
 * engine's record of the request says how it ended) and never a silent failure: the bot waited on it, and the reader
 * should know why. One per chat, the newest, until it is closed; `SecureInputNotice`'s sibling.
 *
 * Above the transcript, under the chat's header, so it keeps its place while the transcript scrolls.
 */
import type { ReactElement } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { useLocale } from '../../i18n/use-locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import { webStrings } from '../../i18n/web-strings'
import { botsStore } from '../../state/bots'
import { type InteractiveNoticeKind, type InteractiveState, interactiveStore } from '../../state/interactive'
import { Button } from '../../ui/primitives'
import { useInteractiveRuntime } from '../requests/interactive-runtime'
import { WithName } from '../requests/with-name'

/** What the chat says about one notice; `name` is the bot's, cleaned. */
export function interactiveNoticeText(notice: InteractiveNoticeKind, name: string): string {
  switch (notice.kind) {
    case 'expired':
      return webStrings.requests.timedOut({ name })
    case 'withdrawn':
      return webStrings.requests.withdrawn({ name })
    case 'answered_elsewhere':
      return webStrings.passkeys.answeredElsewhere({ name })
    case 'lapsed':
      return webStrings.secureInput.noticeLapsed({ name })
    case 'may_not_have_arrived':
      return webStrings.requests.answerMayNotHaveArrived({ name })
    case 'cannot_show': {
      const words = sheetStrings.chat.request

      const what =
        notice.method === 'input.file'
          ? words.whatFile
          : notice.method === 'review.draft'
            ? words.whatDraft
            : notice.method === 'review.diff'
              ? words.whatDiff
              : words.whatForm

      // The person's own choice (`4041 declined`) is said as theirs, not as the page's failure.
      return notice.reason === 'declined'
        ? words.noticeDeclined({ name, what })
        : words.noticeCannotShow({ name, what })
    }
  }
}

export interface InteractiveNoticeProps {
  /** The chat's key: the notices are kept per chat. */
  chatKey: string
  /** The bot whose name the line says. */
  bot: string
  /** The page's own unless a test hands in its own. */
  store?: StoreApi<InteractiveState>
}

export function InteractiveNotice({
  chatKey,
  bot,
  store = interactiveStore
}: InteractiveNoticeProps): ReactElement | null {
  useLocale()

  const entry = useStore(store, state => state.notices[chatKey])
  const name = useStore(botsStore, state => state.byName[bot]?.displayName ?? bot)
  const runtime = useInteractiveRuntime()

  if (!entry) {
    return null
  }

  return (
    <div className="hm-chat__banner" role="status" data-interactive-notice={entry.notice.kind}>
      <p>
        <WithName
          phrase={shown => interactiveNoticeText(entry.notice, shown)}
          name={displayText(name, BOT_NAME_LIMIT)}
        />
      </p>
      <Button variant="quiet" onClick={() => runtime?.dismissNotice(chatKey)}>
        {sheetStrings.secureNotice.close}
      </Button>
    </div>
  )
}
