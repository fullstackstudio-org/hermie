/**
 * A chat's line about a secret, sudo or vault prompt that ended without the
 * reader's answer (it expired, or the bot stopped asking), or about a request
 * only the desktop app can answer, which this page declined. Never a row of the
 * transcript (that is the engine's) and never a silent failure: the bot stalled
 * on it, and the reader should know why. One per chat, the newest, until it is
 * closed; the native apps' `SecureInputNoticeView`.
 *
 * Above the transcript, under the chat's header, so it keeps its place while the
 * transcript scrolls.
 */
import type { ReactElement } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { botsStore } from '../../state/bots'
import { type SecureInputState, secureInputStore, type SecureNoticeKind } from '../../state/secure-input'
import { Button } from '../../ui/primitives'
import { useSecureInputRuntime } from '../requests/secure-input-runtime'
import { WithName } from '../requests/with-name'

/** What the chat says about one notice; `name` is the bot's, cleaned. */
export function secureNoticeText(notice: SecureNoticeKind, name: string): string {
  const words = webStrings.secureInput

  switch (notice.kind) {
    case 'expired':
      return words.noticeExpired({ name })
    case 'withdrawn':
      return words.noticeWithdrawn({ name })
    case 'unsupported':
      return words.noticeUnsupported({ name, method: notice.method })
    case 'lapsed':
      return words.noticeLapsed({ name })
    case 'may_not_have_arrived':
      return words.noticeMayNotHaveArrived({ name })
  }
}

export interface SecureInputNoticeProps {
  /** The chat's key: the notices are kept per chat. */
  chatKey: string
  /** The bot whose name the line says. */
  bot: string
  /** The page's own unless a test hands in its own. */
  store?: StoreApi<SecureInputState>
}

export function SecureInputNotice({
  chatKey,
  bot,
  store = secureInputStore
}: SecureInputNoticeProps): ReactElement | null {
  useLocale()

  const entry = useStore(store, state => state.notices[chatKey])
  const name = useStore(botsStore, state => state.byName[bot]?.displayName ?? bot)
  const runtime = useSecureInputRuntime()

  if (!entry) {
    return null
  }

  return (
    <div className="hm-chat__banner" role="status" data-secure-notice={entry.notice.kind}>
      <p>
        <WithName phrase={shown => secureNoticeText(entry.notice, shown)} name={displayText(name, BOT_NAME_LIMIT)} />
      </p>
      <Button variant="quiet" onClick={() => runtime?.dismissNotice(chatKey)}>
        {webStrings.secureInput.close}
      </Button>
    </div>
  )
}
