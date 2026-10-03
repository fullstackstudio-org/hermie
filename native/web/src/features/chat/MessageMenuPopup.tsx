/**
 * The message menu itself (`MessageMenuLayer` places and opens it): a chunk of
 * its own, fetched the first time the reader points at a message or moves to
 * one, so the first screen does not carry it.
 *
 * The ARIA menu pattern: `role="menu"` of `menuitem`s, focused on its first (or
 * last) line, the arrows, Home and End move, Return or Space chooses, Escape and
 * Tab close it and put focus back where it was. A line that cannot be chosen
 * now (Regenerate while a turn runs) stays, marked `aria-disabled` and described
 * by why. It hangs under its message's bubble (or at the pointer), flips above
 * it at the bottom of the window, follows it while the transcript scrolls, and
 * closes once the message has left the window or a press lands elsewhere.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore
} from 'react'

import { strings } from '../../generated/strings'
import type { ItemHost } from './items/item-host'
import { type MessageMenuId, messageMenuEntries } from './message-menu'
import type { OpenMenu } from './MessageMenu'

function titleOf(id: MessageMenuId): string {
  switch (id) {
    case 'copyText':
      return strings.chat.menu.copyText
    case 'copyMarkdown':
      return strings.chat.menu.copyMarkdown
    case 'regenerate':
      return strings.chat.menu.regenerate
  }
}

export interface PopupProps {
  host: ItemHost
  menu: OpenMenu
  menuId: string
  onClose: (refocus: boolean) => void
  onChoose: (id: MessageMenuId) => void
}

export function MenuPopup({ host, menu, menuId, onClose, onChoose }: PopupProps): ReactElement | null {
  const reasonId = useId()
  const element = useRef<HTMLDivElement>(null)
  const turnActive = useSyncExternalStore(host.subscribe, host.turnActive, host.turnActive)
  const target = useSyncExternalStore(host.subscribe, host.regenerateTarget, host.regenerateTarget)
  const item = host.itemById(menu.id)
  const entries = item ? messageMenuEntries({ item, canRegenerate: target === menu.id, turnActive }) : []

  // Placed through the CSSOM, as the composer sizes its field: the policy refuses a style attribute.
  const place = useCallback((): boolean => {
    const node = element.current
    const { anchor } = menu

    if (!node || !anchor.element.isConnected) {
      return false
    }

    const rect = anchor.element.getBoundingClientRect()
    const view = anchor.element.ownerDocument.documentElement
    const height = view.clientHeight || Number.POSITIVE_INFINITY

    if (rect.bottom < 0 || rect.top > height) {
      return false
    }

    const x = rect.left + anchor.dx
    const y = rect.top + anchor.dy
    const width = node.offsetWidth
    const tall = node.offsetHeight
    const below = y + 4
    const top = below + tall > height - 8 && y - tall - 4 > 8 ? y - tall - 4 : below
    const left = Math.max(8, Math.min(x - width, (view.clientWidth || x) - width - 8))

    node.style.top = `${Math.round(top)}px`
    node.style.left = `${Math.round(Math.max(8, left))}px`

    return true
  }, [menu])

  useLayoutEffect(() => {
    place()

    const lines = element.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    const first = menu.start === 'first' ? lines?.[0] : lines?.[lines.length - 1]

    first?.focus()
    // Only on opening: the lines do not steal focus back as the menu re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A press anywhere else closes it; the transcript moving under it moves it, once a frame.
  useEffect(() => {
    const doc = menu.anchor.element.ownerDocument
    const view = doc.defaultView
    let frame = 0

    const onPointer = (event: Event): void => {
      const node = event.target as Node | null

      if (node && (element.current?.contains(node) || (node instanceof Element && node.closest('.hm-msg-more')))) {
        return
      }

      onClose(false)
    }

    const follow = (): void => {
      if (frame || !view) {
        return
      }

      frame = view.requestAnimationFrame(() => {
        frame = 0

        if (!place()) {
          onClose(false)
        }
      })
    }

    doc.addEventListener('pointerdown', onPointer, true)
    doc.addEventListener('scroll', follow, true)
    view?.addEventListener('resize', follow)

    return () => {
      doc.removeEventListener('pointerdown', onPointer, true)
      doc.removeEventListener('scroll', follow, true)
      view?.removeEventListener('resize', follow)

      if (frame) {
        view?.cancelAnimationFrame(frame)
      }
    }
  }, [menu, onClose, place])

  useEffect(() => {
    if (entries.length === 0) {
      onClose(true)
    }
  }, [entries.length, onClose])

  if (entries.length === 0) {
    return null
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const lines = Array.from(element.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = lines.indexOf(event.target as HTMLElement)
    const move = (index: number): void => {
      event.preventDefault()
      lines[(index + lines.length) % lines.length]?.focus()
    }

    // The transcript's own keys are not this menu's.
    event.stopPropagation()

    switch (event.key) {
      case 'ArrowDown':
        move(at + 1)
        break
      case 'ArrowUp':
        move(at - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(lines.length - 1)
        break
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        onClose(true)
        break
      default:
        break
    }
  }

  return (
    <div
      className="hm-menu"
      id={menuId}
      role="menu"
      aria-label={strings.chat.menu.message}
      ref={element}
      onKeyDown={onKeyDown}
    >
      {entries.map(entry => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="hm-menu__item"
          aria-disabled={entry.disabled ? 'true' : undefined}
          aria-describedby={entry.disabled ? reasonId : undefined}
          onClick={() => {
            if (!entry.disabled) {
              onChoose(entry.id)
            }
          }}
        >
          {titleOf(entry.id)}
        </button>
      ))}
      {entries.some(entry => entry.disabled) ? (
        <span className="hm-sr" id={reasonId}>
          {strings.chat.menu.turnRunning}
        </span>
      ) : null}
    </div>
  )
}
