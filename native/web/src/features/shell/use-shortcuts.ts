/**
 * The page's keyboard shortcuts (`platform/shortcuts.ts` is the table and says what a browser leaves to a page):
 * one `keydown` listener on the document, installed once.
 *
 *  - **Search** focuses the chats field at the top of the list. On a phone-width window with a chat open the list is
 *    not on screen, so the page goes to the list first, and the field takes the focus once it is drawn.
 *  - **Previous and next chat**, and **a chat by its number** (the first nine), walk the chats as the list shows them
 *    at that moment (the rows in the sidebar: folders as the reader has them open, a search narrowing them, the archive
 *    only while it is open), so "the third chat" is the third row the reader can see. Previous and next wrap round.
 *  - **New conversation** goes to the Conversations page of the chat that is open, with its question already open (the
 *    page asks first, because it puts the group chat away for everybody: a shortcut does not get to skip that). With
 *    no chat open it does nothing at all, and the key stays the browser's.
 *  - **Help** opens the list of shortcuts.
 *
 * What it will not do: act while a modal layer is open (a bot's question, a picture, the help itself: whatever is
 * behind a modal is not the reader's to reach), while a key is being held down, while an input method is composing, or
 * on a key a handler has already used. And it cancels the browser's own meaning of a key only when it acts on it.
 */
import { useEffect, useRef } from 'react'

import type { HashRouter } from '../../platform/hash-router'
import { isApplePlatform, isTextTarget, matchShortcut, type ShortcutHit } from '../../platform/shortcuts'
import { askAboutNewConversation } from '../sessions/new-conversation-request'
import { chatHref, conversationsHref, HOME_HASH, type Route } from './router'

export interface ShortcutOptions {
  /** The page's address, to go to a chat. */
  router: HashRouter
  /** Where the page is now: a chat's bot is "this chat". */
  route: Route
  /** Open the list of shortcuts. */
  onHelp: () => void
}

/** The bot a route is about, if it is about one. */
const botOf = (route: Route): string | undefined =>
  route.name === 'chat' || route.name === 'conversations' || route.name === 'profile' ? route.bot : undefined

/** The chats of the list as it is drawn, top to bottom. */
const visibleChats = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.hm-chat-list a[data-bot]'), row => row.dataset.bot ?? '').filter(
    Boolean
  )

/** Whether a modal layer (a bot's question, a picture, the list of shortcuts) is open. */
const modalOpen = (): boolean => document.querySelector('[aria-modal="true"]') !== null

/** Focus the chats field; on a window where the list is not drawn, go to the list and focus it once it is. */
function focusSearch(router: HashRouter): boolean {
  const field = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('.hm-search__field')
  const take = (): boolean => {
    const input = field()

    // A field that is not drawn takes no focus: that is how a hidden list says so.
    input?.focus({ preventScroll: true })

    if (input && document.activeElement === input) {
      input.select()

      return true
    }

    return false
  }

  if (take()) {
    return true
  }

  if (!field()) {
    return false
  }

  router.navigate(HOME_HASH)
  requestAnimationFrame(() => requestAnimationFrame(take))

  return true
}

/** Act on a shortcut. `true` when it did something, which is what lets the key's own meaning be cancelled. */
function act(hit: ShortcutHit, options: ShortcutOptions): boolean {
  const { router, route, onHelp } = options
  const bot = botOf(route)
  const chats = visibleChats()
  const open = (name: string | undefined): boolean => {
    if (name === undefined) {
      return false
    }

    router.navigate(chatHref(name))

    return true
  }

  switch (hit.action) {
    case 'search':
      return focusSearch(router)

    case 'newConversation':
      if (bot === undefined) {
        return false
      }

      askAboutNewConversation(bot)
      router.navigate(conversationsHref(bot))

      return true

    case 'chat':
      return open(chats[(hit.index ?? 0) - 1])

    case 'nextChat':
    case 'previousChat': {
      if (chats.length === 0) {
        return false
      }

      const here = bot === undefined ? -1 : chats.indexOf(bot)
      const step = hit.action === 'nextChat' ? 1 : -1
      // From no chat in the list, next is the first and previous is the last.
      const to = here === -1 ? (step === 1 ? 0 : chats.length - 1) : (here + step + chats.length) % chats.length

      return open(chats[to])
    }

    case 'help':
      onHelp()

      return true
  }
}

export function useShortcuts(options: ShortcutOptions): void {
  // The listener is installed once; what it reads is the latest.
  const latest = useRef(options)

  latest.current = options

  useEffect(() => {
    const apple = isApplePlatform()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat || modalOpen()) {
        return
      }

      const hit = matchShortcut(event, apple)

      if (!hit || (hit.chord.outsideFields && isTextTarget(event.target))) {
        return
      }

      if (act(hit, latest.current)) {
        event.preventDefault()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}
