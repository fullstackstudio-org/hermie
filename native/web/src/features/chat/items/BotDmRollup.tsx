/**
 * `5 messages with @writer · 4 replies`: the one line a run of more than three
 * bot-to-bot asides is drawn as (`dm-rollup.ts` decides which rows those are).
 *
 * It opens in place: the line becomes `Show less` and the asides draw
 * themselves under it, each still closed until the reader opens it, each with
 * the presentation the selectors gave it. The roll-up is one row of the list,
 * so opening it grows that row and the list's anchor keeps the reader's place.
 *
 * The handle is the teammate's, cleaned, bounded and isolated.
 */
import { memo, useId, useState } from 'react'

import { BOT_NAME_LIMIT, displayText } from '../../../core/requests/secure-input'
import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { Icon } from '../../../ui/icons'
import { WithName } from '../../requests/with-name'
import type { DmRollupItem } from '../dm-rollup'
import { BotDmAside } from './BotDmAside'
import { type RowViewProps, sameRowView } from './row-view'

function BotDmRollupView({ item }: RowViewProps<DmRollupItem>) {
  useLocale()

  const bodyId = useId()
  const [open, setOpen] = useState(false)
  const count = item.members.length
  const handle = item.handle === undefined ? '' : displayText(item.handle, BOT_NAME_LIMIT)

  const label = open ? (
    strings.chat.fold.less
  ) : handle ? (
    <WithName
      phrase={name => strings.chat.botDm.rollup({ count, handle: name, replies: item.replies })}
      name={handle}
    />
  ) : (
    strings.chat.botDm.rollupMixed({ count, replies: item.replies })
  )

  return (
    <div className="hm-rollup">
      <button
        className="hm-rollup__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(current => !current)}
      >
        <span className="hm-dm__arrow" aria-hidden="true">
          {'⇄'}
        </span>
        <span>{label}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>
      {open ? (
        <div className="hm-rollup__members" id={bodyId}>
          {item.members.map(member =>
            member.item.kind === 'bot_dm_in' || member.item.kind === 'bot_dm_out' ? (
              <BotDmAside key={member.item.id} item={member.item} presentation={member.presentation} />
            ) : null
          )}
        </div>
      ) : null}
    </div>
  )
}

export const BotDmRollup = memo(BotDmRollupView, sameRowView)
