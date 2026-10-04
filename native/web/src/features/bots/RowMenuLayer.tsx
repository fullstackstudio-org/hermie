/**
 * What opens a chat row's menu, and holds it: a chunk of its own (`ChatList` asks for it as soon as the list has
 * drawn), so nothing of the menu is in the first load but the small button every row carries.
 *
 * It listens on the list, not on the rows (one listener each, whatever the number of chats):
 *
 *  - a click on a row's button (`.hm-row__more`) opens that row's menu under the button, and a second click
 *    on it closes it;
 *  - a right click on a row opens it at the pointer, except with Shift, which keeps the browser's own menu;
 *  - the context-menu key and Shift+F10 on the focused row open it under the row's button;
 *  - Right on the focused row moves to its button, which is out of the tab order (the list is one tab stop),
 *    and Left or Escape on the button goes back to the row.
 *
 * The button says it opens a menu (`aria-haspopup`) and whether it is open (`aria-expanded`, set here on the
 * element itself: the row does not know). The menu is `RowMenu.tsx`; closing it gives the focus back to what
 * it came from, or, when that row left the list (archived), to the list's own stop.
 */
import { type ReactElement, type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react'

import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import { VisuallyHidden } from '../../ui/primitives'
import { profileHref } from '../shell/router'
import { RowMenu } from './RowMenu'

/** How long a context-menu event after a key is the same request again (a key opens it on keydown, and the browser may too). */
const ECHO_MS = 600

const BUTTON = '.hm-row__more'

interface Open {
  bot: string
  /** The element the menu hangs from. */
  anchor: HTMLElement
  /** Where the pointer asked for it, in the window. */
  point?: { x: number; y: number }
  start: 'first' | 'last'
  /** Where focus goes when the menu closes. */
  returnTo: HTMLElement
}

export interface RowMenuLayerProps {
  /** The list's own element, which the rows are drawn in. */
  container: RefObject<HTMLElement | null>
  /** The page's address, unless a test hands in its own: Edit profile goes there. */
  router?: HashRouter
}

const rowOf = (target: EventTarget | null): HTMLAnchorElement | null =>
  target instanceof Element ? target.closest<HTMLAnchorElement>('a[data-bot]') : null

const buttonOfRow = (row: Element): HTMLButtonElement | null =>
  row.closest('li')?.querySelector<HTMLButtonElement>(BUTTON) ?? null

export function RowMenuLayer({ container, router = pageHashRouter }: RowMenuLayerProps): ReactElement {
  const menuId = useId()
  const [menu, setMenu] = useState<Open | null>(null)
  const menuRef = useRef(menu)
  /** What the last choice did, said politely: a row that is pinned or archived moves, and nothing else tells. */
  const [said, setSaid] = useState('')
  /** Where focus goes once the page has drawn what the closing choice changed (a row may have left the list). */
  const refocus = useRef<HTMLElement | null>(null)
  const echoUntil = useRef(0)

  menuRef.current = menu

  const onClose = useCallback((giveBack: boolean) => {
    refocus.current = giveBack ? (menuRef.current?.returnTo ?? null) : null
    setMenu(null)
  }, [])

  useEffect(() => {
    const root = container.current

    if (!root) {
      return undefined
    }

    // The same press on the open menu's own button closes it; any other opens that row's.
    const request = (next: Open): void =>
      setMenu(current => (current && current.bot === next.bot && next.point === undefined ? null : next))

    const onClick = (event: MouseEvent): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(BUTTON) : null
      const row = button?.closest('li')?.querySelector<HTMLAnchorElement>('a[data-bot]')

      if (button && row) {
        request({ bot: row.dataset.bot ?? '', anchor: button, start: 'first', returnTo: button })
      }
    }

    const onContextMenu = (event: MouseEvent): void => {
      const row = rowOf(event.target)

      // Shift keeps the browser's own menu, as it does everywhere.
      if (!row || event.shiftKey) {
        return
      }

      event.preventDefault()

      if (Date.now() >= echoUntil.current) {
        request({
          bot: row.dataset.bot ?? '',
          anchor: buttonOfRow(row) ?? row,
          point: { x: event.clientX, y: event.clientY },
          start: 'first',
          returnTo: row
        })
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      const row = rowOf(event.target)

      if (row && event.target === row) {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          echoUntil.current = Date.now() + ECHO_MS
          request({ bot: row.dataset.bot ?? '', anchor: buttonOfRow(row) ?? row, start: 'first', returnTo: row })
        } else if (event.key === 'ArrowRight' && !event.shiftKey) {
          event.preventDefault()
          buttonOfRow(row)?.focus()
        }

        return
      }

      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(BUTTON) : null

      if (button && (event.key === 'ArrowLeft' || (event.key === 'Escape' && menuRef.current === null))) {
        event.preventDefault()
        button.closest('li')?.querySelector<HTMLAnchorElement>('a[data-bot]')?.focus()
      }
    }

    root.addEventListener('click', onClick)
    root.addEventListener('contextmenu', onContextMenu)
    root.addEventListener('keydown', onKeyDown)
    // Until this is here the buttons do nothing: a test (or a very quick hand) can tell.
    root.dataset.rowMenus = 'ready'

    return () => {
      delete root.dataset.rowMenus
      root.removeEventListener('click', onClick)
      root.removeEventListener('contextmenu', onContextMenu)
      root.removeEventListener('keydown', onKeyDown)
    }
  }, [container])

  // The button of the open menu says so, and the others say they are closed.
  useEffect(() => {
    for (const button of container.current?.querySelectorAll<HTMLElement>(BUTTON) ?? []) {
      button.setAttribute('aria-expanded', button === menu?.anchor ? 'true' : 'false')
    }
  }, [container, menu])

  useEffect(() => {
    const target = refocus.current

    if (menu !== null || !target) {
      return
    }

    refocus.current = null

    // A row that left the list (archived) has nothing to give focus back to: the list's own stop takes it.
    const to = target.isConnected
      ? target
      : target.ownerDocument.querySelector<HTMLElement>('.hm-chat-list a[data-bot][tabindex="0"]')

    to?.focus({ preventScroll: true })
  })

  return (
    <>
      {menu ? (
        <RowMenu
          key={menu.bot}
          bot={menu.bot}
          anchor={menu.anchor}
          point={menu.point}
          start={menu.start}
          menuId={menuId}
          onClose={onClose}
          onAnnounce={setSaid}
          onEditProfile={bot => router.navigate(profileHref(bot))}
        />
      ) : null}

      {/* Only while it has something to say: a status that is always there is one more for every query to tell apart. */}
      {said ? (
        <VisuallyHidden>
          <span role="status">{said}</span>
        </VisuallyHidden>
      ) : null}
    </>
  )
}
