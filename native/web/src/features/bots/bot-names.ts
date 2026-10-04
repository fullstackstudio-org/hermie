/**
 * What a bot is CALLED, resolved into the two lines every surface draws (the Expo app's `store/bot-names.ts`).
 *
 * A Hermes profile carries two names. The handle (`profiles.list`'s `name`, `lance-vance`) is the bot's identity: it
 * is what `@`-addressing uses, what a cron names and the only one of the two that is unique. The display name is a
 * label somebody typed, and it is optional, mutable and free to collide. The reader has a third, their own name for
 * the bot (the arrangement's `labels`, set on its profile page), which wins over the display name and is the one
 * a gateway offers no way to write.
 *
 * **Which of them is the large one is one global setting** (`state/settings.ts`: `botNameOrder`, and
 * `hideHandleWhenNamed`, which hides the handle altogether) and not a decision each surface makes for itself. With
 * both defaults, a named bot shows its name alone, which is what the page showed before there was a setting.
 *
 * ## The one-line case is not a special case
 *
 * A bot with no name of its own, or one whose name is its handle in different case, has one name and not two:
 * drawing "researcher" over "Researcher" would be a second line that adds nothing, so `secondary` is empty and every
 * surface already has to handle that. The line it does show is the name as it is written (`Researcher`), not the
 * handle, which is where this differs from the Expo app: a list that said `researcher` where it has always said
 * `Researcher` would change every row of every reader who never touched the setting.
 *
 * Everything is the bot's own words, or the reader's: cleaned and bounded like a request's (`botLabel`), and isolated
 * by the surface that draws it in a line of its own.
 *
 * Pure, so a row, a heading and a test all answer the same; `useBotNames` asks it of the page's stores.
 */
import { useMemo } from 'react'
import { useStore } from 'zustand'

import { botsStore } from '../../state/bots'
import { layoutStore } from '../../state/layout'
import { type NameOrder, settingsStore } from '../../state/settings'
import { botLabel } from './bot-label'

/** The two lines, already in the order this reader asked for. */
export interface BotNames {
  primary: string
  /** Empty when the bot has only one name worth showing. */
  secondary: string
}

/** Just enough of a bot to name it. */
export interface NameableBot {
  /** The handle. */
  name: string
  /** The roster's display name; absent or empty for a bot that has none. */
  displayName?: string | undefined
  /** What this reader calls the bot; wins over `displayName`. */
  label?: string | undefined
}

export function botNames(bot: NameableBot, order: NameOrder, hideHandle: boolean): BotNames {
  const handle = botLabel(undefined, bot.name)
  // A name with nothing visible in it is no name: it falls back to the next, as a cleared field does.
  const display = botLabel(bot.label, '') || botLabel(bot.displayName, '')
  const same = display === '' || display.toLowerCase() === handle.toLowerCase()

  if (same) {
    return { primary: display || handle, secondary: '' }
  }

  // With the setting on a bot that has a name is always led with it, whatever the order says: an order that still
  // surfaced the handle one way round would be the setting lying about what it does.
  if (hideHandle) {
    return { primary: display, secondary: '' }
  }

  return order === 'display' ? { primary: display, secondary: handle } : { primary: handle, secondary: display }
}

/** The two lines for one bot, from the page's stores. */
export function useBotNames(name: string | undefined, displayName?: string): BotNames {
  const fromRoster = useStore(botsStore, state => (name === undefined ? undefined : state.byName[name]?.displayName))
  const label = useStore(layoutStore, state => (name === undefined ? undefined : state.labels[name]))
  const order = useStore(settingsStore, state => state.botNameOrder)
  const hideHandle = useStore(settingsStore, state => state.hideHandleWhenNamed)

  return useMemo(
    () => botNames({ name: name ?? '', displayName: displayName ?? fromRoster, label }, order, hideHandle),
    [name, displayName, fromRoster, label, order, hideHandle]
  )
}
