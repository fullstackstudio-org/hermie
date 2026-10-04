/**
 * The mark in a chat's header while YOLO mode is on: the approval requests of
 * this conversation are skipped, and nobody should have to open the options to
 * find that out.
 *
 * A button, because the way out is the mark itself: one press turns it off, no
 * confirmation (only turning it ON asks). Its accessible name says what it
 * means and what it does; the word on it is the mode's name. It is drawn from
 * the session's own report (`use-yolo.ts`), so a refused switch never leaves it
 * on screen, and it is shown while the connection is down too, because the mode
 * is still in force on the gateway then.
 */
import { type ReactElement } from 'react'

import { useLocale } from '../../i18n/use-locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import type { YoloControl } from './use-yolo'

export interface YoloBadgeProps {
  yolo: YoloControl
}

export function YoloBadge({ yolo }: YoloBadgeProps): ReactElement | null {
  useLocale()

  if (!yolo.on) {
    return null
  }

  const label = sheetStrings.chat.yolo.badgeLabel

  return (
    <button
      type="button"
      className="hm-yolo-badge"
      aria-label={label}
      title={label}
      aria-disabled={!yolo.available || yolo.busy ? true : undefined}
      onClick={() => {
        if (yolo.available && !yolo.busy) {
          void yolo.set(false)
        }
      }}
    >
      {sheetStrings.chat.yolo.badge}
    </button>
  )
}
