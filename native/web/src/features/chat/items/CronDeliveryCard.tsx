/**
 * A scheduled job's report, delivered into this chat, as a card of its own.
 *
 * The gateway injects a delivery as a real inbound turn, so it persists as a
 * `role: user` row; it is neither the owner speaking nor speech at all, but the
 * scheduler, so it is never a bubble (the Expo app's §6.5, the Swift
 * `CronDeliveryCardView`). The header is a button: a clock glyph, `CRON`, the
 * job's name and `ran 04:22 · delivered to this chat`. Open, it is the report as
 * Markdown.
 *
 * It starts open where the selectors hand it over as `full` (normal and
 * verbose) and closed where `quiet` folds it to `collapsed`; one click pins it.
 * A name the redactor replaced is not a name, so the card says `Scheduled job`
 * instead of titling itself with the placeholder.
 *
 * The native apps also offer "Open cron" and "Run now"; this client has no cron
 * screen to open, and a button that leads nowhere is not offered.
 */
import type { CronDeliveryItem } from '@hermie/transcript'
import { memo, useId, useState } from 'react'

import { displayText, NAME_LIMIT } from '../../../core/requests/secure-input'
import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { Icon } from '../../../ui/icons'
import { clockOf } from '../chat-format'
import { MessageMarkdown } from './MessageMarkdown'
import { type RowViewProps, sameRowView } from './row-view'

/** The job's name as the card titles it: the header's, cleaned, or `Scheduled job`. */
export function cronJobName(item: Pick<CronDeliveryItem, 'jobName' | 'nameRedacted'>): string {
  const name = item.nameRedacted ? '' : displayText(item.jobName, NAME_LIMIT)

  return name || strings.chat.cron.unnamed
}

function CronDeliveryCardView({ item, presentation }: RowViewProps<CronDeliveryItem>) {
  useLocale()

  const bodyId = useId()
  // `null`: the reader has not decided, so `quiet` folds the card and the other levels open it.
  const [chosen, setChosen] = useState<boolean | null>(null)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const name = cronJobName(item)

  if (presentation === 'chip') {
    return (
      <p className="hm-chip" data-kind="cron_delivery">
        {strings.chat.cron.eyebrow} · <bdi>{name}</bdi>
      </p>
    )
  }

  const open = chosen ?? presentation === 'full'
  const clock = clockOf(item.ts)

  return (
    <article className="hm-cron" data-open={open ? 'true' : 'false'}>
      <button
        className="hm-cron__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setChosen(!open)}
      >
        <span className="hm-cron__glyph" aria-hidden="true">
          {'◴'}
        </span>
        <span className="hm-cron__heading">
          <span className="hm-cron__eyebrow">{strings.chat.cron.eyebrow}</span>
          <span className="hm-cron__name">
            <bdi>{name}</bdi>
          </span>
          <span className="hm-cron__meta">
            {clock ? strings.chat.cron.ranAt({ time: clock }) : strings.chat.cron.delivered}
          </span>
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>
      {open ? (
        <div className="hm-cron__body" id={bodyId}>
          {item.body.trim() ? (
            <MessageMarkdown text={item.body} />
          ) : (
            <p className="hm-cron__empty">{strings.chat.cron.emptyBody}</p>
          )}
        </div>
      ) : null}
    </article>
  )
}

export const CronDeliveryCard = memo(CronDeliveryCardView, sameRowView)
