/**
 * The gateway's out-of-band notices (`notification.show`): a credits line, "still
 * starting the agent", and the like, each with a Close button, until the gateway
 * clears it, its lifetime runs out or the person closes it (`core/notices.ts`).
 *
 * Over the page and over a dialog alike (the request layer keeps the area out of
 * the inert page), because a notice is about the account rather than the chat on
 * screen. The text is the gateway's, relayed from the agent: plain text, cleaned by
 * the model, never Markdown or a link. A notice about one chat names its bot,
 * isolated in `<bdi>`.
 *
 * An `info` or `success` notice is a status (read when the reader gets to it); a
 * `warn` or `error` is an alert. The native apps' notice banner.
 */
import type { ReactElement } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { botOfConversationKey } from '../../core/sessions/session-model'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { botsStore } from '../../state/bots'
import { type GatewayNotice, type NoticesState, noticesStore } from '../../state/notices'
import { Button } from '../../ui/primitives'
import { WithName } from '../requests/with-name'
import { useSessionSignalsRuntime } from './signals-runtime'

function NoticeItem({ notice, onClose }: { notice: GatewayNotice; onClose: () => void }): ReactElement {
  const bot = notice.chat === undefined ? undefined : botOfConversationKey(notice.chat)
  const name = useStore(botsStore, state => (bot === undefined ? '' : (state.byName[bot]?.displayName ?? bot)))
  const shown = displayText(name, BOT_NAME_LIMIT)
  const urgent = notice.level === 'warn' || notice.level === 'error'

  return (
    <li className="hm-notices__item" data-level={notice.level} data-notice-id={notice.id}>
      <p className="hm-notices__text" role={urgent ? 'alert' : 'status'}>
        {shown ? (
          <>
            <span className="hm-notices__from">
              <WithName phrase={who => webStrings.gatewayNotices.fromBot({ name: who })} name={shown} />
            </span>{' '}
          </>
        ) : null}
        {notice.text}
      </p>
      <Button
        variant="quiet"
        aria-label={webStrings.gatewayNotices.closeLabel({ text: notice.text.slice(0, 80) })}
        onClick={onClose}
      >
        {webStrings.gatewayNotices.close}
      </Button>
    </li>
  )
}

export function GatewayNotices({ store = noticesStore }: { store?: StoreApi<NoticesState> }): ReactElement | null {
  useLocale()

  const notices = useStore(store, state => state.notices)
  const runtime = useSessionSignalsRuntime()

  if (notices.length === 0) {
    return null
  }

  return (
    <ul className="hm-notices" aria-label={webStrings.gatewayNotices.label}>
      {notices.map(notice => (
        <NoticeItem
          key={`${notice.id}\u0000${notice.serial}`}
          notice={notice}
          onClose={() => runtime?.notices.dismiss(notice.id)}
        />
      ))}
    </ul>
  )
}
