/**
 * "Jump to latest": a button over the bottom of the transcript while the reader
 * is somewhere above it. It carries how many messages arrived since they left the
 * bottom, because that number is why it is there.
 */
import type { ReactElement } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { Icon } from '../../ui/icons'

export interface JumpToLatestProps {
  /** Messages that arrived since the reader scrolled up. */
  count: number
  onJump: () => void
}

export function JumpToLatest({ count, onJump }: JumpToLatestProps): ReactElement {
  useLocale()

  return (
    <button className="hm-jump" type="button" onClick={onJump}>
      <Icon name="arrowDown" size={18} />
      <span>{strings.chat.transcript.jumpToLatest}</span>
      {count > 0 ? <span className="hm-jump__count">{strings.chat.transcript.newMessages({ count })}</span> : null}
    </button>
  )
}
