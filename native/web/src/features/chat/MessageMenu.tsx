/**
 * The transcript's one message menu: Copy text, Copy as Markdown, Read aloud, Edit
 * and resend, Regenerate, Branch from here and Copy link(s), for whichever message
 * the reader points at, presses on or has focused.
 *
 * What a menu offers is `message-menu.ts`. This is how it is reached, and the
 * shape of it is a performance decision before it is anything else: a control
 * of its own in every message (a button beside the bubble, under it, or
 * positioned out of the flow) made WebKit lay out a two-thousand-row history
 * three times slower. So no message holds a control. A message only carries two
 * attributes (`messageTargetProps`: its item id and the keys that open its
 * actions), and everything here is one instance per transcript, listening on
 * the element the transcript is drawn in:
 *
 *  - **Pointer.** Hovering a message (or tapping one) shows one small "more"
 *    button on the corner of its bubble: a single element, moved from message
 *    to message, kept out of the tab order (the keyboard has its own way in).
 *    A right-click on a message opens the menu where the pointer is, except on
 *    a link or with a selection inside the message, where the browser's own
 *    menu is what the reader wants. A long press does the same on a touch
 *    screen.
 *  - **Keyboard.** The transcript stays one tab stop (`role="log"`). From it,
 *    or from a message, the up and down arrows move focus between messages
 *    (roving: the message focused gets `tabindex="-1"`, nothing enters the tab
 *    order), Home and End go to the first and last one loaded, Escape goes back
 *    to the transcript, and Enter, the context-menu key or Shift+F10 opens the
 *    focused message's menu. The transcript's description says so.
 *  - **The menu** is the ARIA menu pattern (`MessageMenuPopup.tsx`, a chunk of
 *    its own, fetched the first time the reader points at a message or moves
 *    to one): focused on its first line, Escape and Tab close it and put focus
 *    back where it was.
 *
 * Whether a turn runs, which reply may be regenerated, which turn put back in the
 * composer and whether the chat can be branched are read from the host only while
 * the menu is open (`useSyncExternalStore`), and the text a line acts
 * on is read off the item when the line is chosen.
 */
import type { TranscriptItem } from '@hermie/transcript'
import {
  lazy,
  type ReactElement,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import type { ItemHost } from './items/item-host'
import {
  MESSAGE_ID_ATTRIBUTE,
  type MessageMenuEntry,
  type MessageMenuId,
  messageMenuAction,
  messageMenuEntries
} from './message-menu'
import '../../ui/primitives/primitives.css'
import './message-menu.css'

const loadPopup = () => import('./MessageMenuPopup')
const MenuPopup = lazy(() => loadPopup().then(module => ({ default: module.MenuPopup })))

/** Fetch the menu's chunk before it is asked for; a failure is the lazy load's to report when it is. */
let popupRequested = false
const preloadPopup = (): void => {
  if (!popupRequested) {
    popupRequested = true
    void loadPopup().catch(() => {
      popupRequested = false
    })
  }
}

/** How long a finger stays down before it is a long press. */
export const LONG_PRESS_MS = 500

/** How far a finger may wander and still be pressing, not scrolling. */
const PRESS_SLOP = 10

/** How long a context-menu event after a key or a long press is the same request again. */
const ECHO_MS = 600

export interface MessageMenuLayerProps {
  /** The element the transcript is drawn in; the layer is rendered inside it and listens on it. */
  container: RefObject<HTMLElement | null>
  host: ItemHost
}

/** Where a menu hangs: a point relative to an element's top-left corner, followed as the element moves. */
export interface Anchor {
  element: HTMLElement
  dx: number
  dy: number
}

export interface OpenMenu {
  id: string
  anchor: Anchor
  start: 'first' | 'last'
  /** Where focus goes when the menu closes; `null` leaves it where it is. */
  returnTo: HTMLElement | null
}

interface Hovered {
  id: string
  element: HTMLElement
}

const SELECTOR = `[${MESSAGE_ID_ATTRIBUTE}]`

const idOf = (message: HTMLElement): string => message.getAttribute(MESSAGE_ID_ATTRIBUTE) ?? ''

/** The message `node` is in, inside `container`, or `null`. */
function messageOf(node: EventTarget | null, container: HTMLElement): HTMLElement | null {
  if (!(node instanceof Element)) {
    return null
  }

  const message = node.closest<HTMLElement>(SELECTOR)

  return message && container.contains(message) ? message : null
}

/** What the menu and the hover button sit against: the message's bubble where it has one. */
const bubbleOf = (message: HTMLElement): HTMLElement =>
  message.querySelector<HTMLElement>('.hm-bubble, .hm-failure') ?? message

const isOwn = (message: HTMLElement): boolean => message.getAttribute('data-side') === 'own'

/** The newest (`-1`) or oldest (`1`) message whose box is in the log's viewport, scanning out from the newest. */
function messageInView(messages: readonly HTMLElement[], log: HTMLElement, direction: 1 | -1): HTMLElement | null {
  const view = log.getBoundingClientRect()
  let newest = -1

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const rect = messages[index]!.getBoundingClientRect()

    if (rect.top < view.bottom && rect.bottom > view.top) {
      newest = index
      break
    }

    if (rect.bottom <= view.top) {
      break
    }
  }

  if (newest < 0) {
    return messages[messages.length - 1] ?? null
  }

  if (direction === -1) {
    return messages[newest] ?? null
  }

  let oldest = newest

  while (oldest > 0) {
    const rect = messages[oldest - 1]!.getBoundingClientRect()

    if (!(rect.top < view.bottom && rect.bottom > view.top)) {
      break
    }

    oldest -= 1
  }

  return messages[oldest] ?? null
}

function focusMessage(message: HTMLElement): void {
  if (!message.hasAttribute('tabindex')) {
    message.setAttribute('tabindex', '-1')
  }

  message.focus({ preventScroll: true })
  message.scrollIntoView?.({ block: 'nearest' })
}

/** The entries for a message as it is now, or none (a message with nothing to copy and nothing to run again). */
function entriesFor(host: ItemHost, id: string, item: TranscriptItem | undefined): MessageMenuEntry[] {
  return item
    ? messageMenuEntries({
        item,
        canRegenerate: host.regenerateTarget() === id,
        canEditResend: host.editTarget() === id,
        canBranch: host.canBranch(),
        turnActive: host.turnActive(),
        canReadAloud: host.canReadAloud?.() ?? false,
        reading: host.readingIds?.().includes(id) ?? false
      })
    : []
}

export function MessageMenuLayer({ container, host }: MessageMenuLayerProps): ReactElement {
  useLocale()

  const menuId = useId()
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const more = useRef<HTMLButtonElement>(null)
  const menuRef = useRef(menu)
  const hoveredRef = useRef(hovered)
  /** The message the arrows move from when they start on the transcript itself. */
  const active = useRef<string | null>(null)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null)
  /** Until when a context-menu event is the echo of a key or a long press that already opened the menu. */
  const echoUntil = useRef(0)

  menuRef.current = menu
  hoveredRef.current = hovered

  const openFor = useCallback(
    (
      message: HTMLElement,
      how: { point?: { x: number; y: number }; start?: 'first' | 'last'; returnTo: HTMLElement | null }
    ) => {
      const id = idOf(message)

      if (entriesFor(host, id, host.itemById(id)).length === 0) {
        return
      }

      const bubble = bubbleOf(message)
      const rect = bubble.getBoundingClientRect()
      const anchor = how.point
        ? { element: bubble, dx: how.point.x - rect.left, dy: how.point.y - rect.top }
        : { element: bubble, dx: rect.width, dy: rect.height }

      setHovered({ id, element: message })
      setMenu({ id, anchor, start: how.start ?? 'first', returnTo: how.returnTo })
    },
    [host]
  )

  const onClose = useCallback((refocus: boolean) => {
    const closing = menuRef.current

    setMenu(null)

    if (refocus && closing?.returnTo?.isConnected) {
      closing.returnTo.focus({ preventScroll: true })
    }
  }, [])

  const onChoose = useCallback(
    (id: MessageMenuId) => {
      const closing = menuRef.current

      onClose(true)

      const item = closing ? host.itemById(closing.id) : undefined
      const action = item ? messageMenuAction(id, item) : null

      if (!action) {
        return
      }

      if (action.kind === 'regenerate') {
        host.regenerate()

        return
      }

      // The words are read off the item now, not when the menu was built: a reply can still have been growing.
      if (action.kind === 'readAloud') {
        host.toggleReadAloud?.(closing?.id ?? '', action.text)

        return
      }

      if (action.kind === 'editResend') {
        host.editResend(action.text, action.attachments)

        return
      }

      if (action.kind === 'branch') {
        host.branch(closing?.id ?? '', action.text)

        return
      }

      void host
        .copy(action.kind === 'copyLink' ? action.href : action.text)
        .then(copied => host.announce(copied ? sheetStrings.markdown.copied : sheetStrings.markdown.copyFailed))
    },
    [host, onClose]
  )

  // The hover button sits on the outer top corner of the hovered message's bubble.
  const placeMore = useCallback((): void => {
    const node = more.current
    const current = hoveredRef.current

    if (!node || !current) {
      return
    }

    if (!current.element.isConnected) {
      node.removeAttribute('data-placed')

      return
    }

    const rect = bubbleOf(current.element).getBoundingClientRect()
    const x = isOwn(current.element) ? rect.left : rect.right

    node.style.top = `${Math.round(rect.top)}px`
    node.style.left = `${Math.round(x)}px`
    node.setAttribute('data-placed', '')
  }, [])

  useLayoutEffect(() => {
    placeMore()
  }, [hovered, placeMore])

  // Everything the transcript tells the layer comes through these listeners on its container.
  useEffect(() => {
    const root = container.current

    if (!root) {
      return undefined
    }

    const doc = root.ownerDocument
    const view = doc.defaultView
    let frame = 0

    const log = (): HTMLElement | null => root.querySelector<HTMLElement>('[role="log"]')
    const messages = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(SELECTOR))
    const activeElement = (): HTMLElement | null =>
      doc.activeElement instanceof HTMLElement && root.contains(doc.activeElement) ? doc.activeElement : null

    const step = (from: HTMLElement | null, direction: 1 | -1): void => {
      const all = messages()
      const list = log()

      if (all.length === 0 || !list) {
        return
      }

      let next: HTMLElement | null

      if (from) {
        next = all[all.indexOf(from) + direction] ?? null
      } else {
        next = all.find(message => idOf(message) === active.current) ?? messageInView(all, list, direction)
      }

      if (next) {
        active.current = idOf(next)
        focusMessage(next)
      }
    }

    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null

      if (!target || target.closest('.hm-menu')) {
        return
      }

      const onLog = target.getAttribute('role') === 'log' && root.contains(target)
      const message = target.hasAttribute(MESSAGE_ID_ATTRIBUTE) ? target : null

      if (!onLog && !message) {
        return
      }

      const opening = (): void => {
        if (message) {
          event.preventDefault()
          echoUntil.current = Date.now() + ECHO_MS
          openFor(message, { returnTo: message })
        }
      }

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault()
          step(message, event.key === 'ArrowDown' ? 1 : -1)
          break
        case 'Home':
        case 'End': {
          if (message) {
            const all = messages()
            const edge = event.key === 'Home' ? all[0] : all[all.length - 1]

            event.preventDefault()

            if (edge) {
              active.current = idOf(edge)
              focusMessage(edge)
            }
          }
          break
        }
        case 'Enter':
        case 'ContextMenu':
          opening()
          break
        case 'F10':
          if (event.shiftKey) {
            opening()
          }
          break
        case 'Escape':
          if (message) {
            event.preventDefault()
            log()?.focus({ preventScroll: true })
          }
          break
        default:
          break
      }
    }

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as HTMLElement | null

      preloadPopup()

      if (target?.hasAttribute(MESSAGE_ID_ATTRIBUTE)) {
        active.current = idOf(target)
      }
    }

    const onOver = (event: PointerEvent): void => {
      const message = messageOf(event.target, root)

      if (message) {
        preloadPopup()
      }

      if (message && hoveredRef.current?.element !== message) {
        setHovered({ id: idOf(message), element: message })
      }
    }

    const onLeave = (event: PointerEvent): void => {
      // A finger lifts as it leaves; the button stays on what it tapped until the next tap.
      if (event.pointerType !== 'touch' && !menuRef.current) {
        setHovered(null)
      }
    }

    const cancelPress = (): void => {
      if (press.current && !press.current.fired) {
        clearTimeout(press.current.timer)
        press.current = null
      }
    }

    /** Whether the reader had words selected in the message before a secondary press (Safari selects one on it). */
    let selectedBeforePress: { message: HTMLElement; selected: boolean; at: number } | null = null

    const selectedIn = (message: HTMLElement): boolean => {
      const selection = doc.getSelection()

      return Boolean(
        selection && !selection.isCollapsed && selection.anchorNode && message.contains(selection.anchorNode)
      )
    }

    const onDown = (event: PointerEvent): void => {
      cancelPress()

      if (event.button === 2) {
        const message = messageOf(event.target, root)

        selectedBeforePress = message ? { message, selected: selectedIn(message), at: Date.now() } : null
      }

      if (event.pointerType !== 'touch') {
        return
      }

      const message = messageOf(event.target, root)

      if (!message) {
        return
      }

      const point = { x: event.clientX, y: event.clientY }
      const pressing = {
        x: point.x,
        y: point.y,
        fired: false,
        timer: setTimeout(() => {
          pressing.fired = true
          echoUntil.current = Date.now() + ECHO_MS
          openFor(message, { point, returnTo: null })
        }, LONG_PRESS_MS)
      }

      press.current = pressing
    }

    const onMove = (event: PointerEvent): void => {
      const pressing = press.current

      if (
        pressing &&
        !pressing.fired &&
        Math.hypot(event.clientX - pressing.x, event.clientY - pressing.y) > PRESS_SLOP
      ) {
        cancelPress()
      }
    }

    // The tap that ends a long press is not also a tap on what is under the finger.
    const onClick = (event: MouseEvent): void => {
      if (press.current?.fired) {
        event.preventDefault()
        event.stopPropagation()
        press.current = null
      }
    }

    const onContext = (event: MouseEvent): void => {
      const message = messageOf(event.target, root)

      if (!message) {
        return
      }

      if (Date.now() < echoUntil.current) {
        event.preventDefault()

        return
      }

      // A link, a field, or words the reader had selected: the browser's own menu is the one they asked for. What
      // counts is the selection before the press, because Safari selects the word under a secondary press itself.
      const before =
        selectedBeforePress && selectedBeforePress.message === message && Date.now() - selectedBeforePress.at < 2_000
          ? selectedBeforePress
          : null
      const hadSelection = before ? before.selected : selectedIn(message)

      selectedBeforePress = null

      if ((event.target as Element).closest('a[href], input, textarea, select') || hadSelection) {
        return
      }

      // The word the press itself selected goes again: the reader asked for the message, not for that word.
      if (before && selectedIn(message)) {
        doc.getSelection()?.removeAllRanges()
      }

      event.preventDefault()
      openFor(message, { point: { x: event.clientX, y: event.clientY }, returnTo: activeElement() })
    }

    const follow = (): void => {
      if (frame || !view || !hoveredRef.current) {
        return
      }

      frame = view.requestAnimationFrame(() => {
        frame = 0
        placeMore()
      })
    }

    root.addEventListener('keydown', onKey)
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('pointerover', onOver)
    root.addEventListener('pointerleave', onLeave)
    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', cancelPress)
    root.addEventListener('pointercancel', cancelPress)
    root.addEventListener('click', onClick, true)
    root.addEventListener('contextmenu', onContext)
    root.addEventListener('scroll', follow, true)
    view?.addEventListener('resize', follow)

    return () => {
      root.removeEventListener('keydown', onKey)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerleave', onLeave)
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', cancelPress)
      root.removeEventListener('pointercancel', cancelPress)
      root.removeEventListener('click', onClick, true)
      root.removeEventListener('contextmenu', onContext)
      root.removeEventListener('scroll', follow, true)
      view?.removeEventListener('resize', follow)

      if (frame) {
        view?.cancelAnimationFrame(frame)
      }

      if (press.current) {
        clearTimeout(press.current.timer)
        press.current = null
      }
    }
  }, [container, openFor, placeMore])

  const expanded = menu !== null && hovered !== null && menu.id === hovered.id

  return (
    <>
      {hovered ? (
        <button
          ref={more}
          type="button"
          className="hm-msg-more"
          tabIndex={-1}
          aria-label={strings.chat.menu.message}
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={expanded ? menuId : undefined}
          // A pointer's button: it does not take focus from where the reader was.
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            if (expanded) {
              onClose(false)
            } else if (hovered.element.isConnected) {
              // Back to where the reader was; for a screen reader that pressed it from its own cursor, the message.
              const focused = hovered.element.ownerDocument.activeElement

              if (!hovered.element.hasAttribute('tabindex')) {
                hovered.element.setAttribute('tabindex', '-1')
              }

              openFor(hovered.element, {
                returnTo:
                  focused instanceof HTMLElement && focused !== focused.ownerDocument.body ? focused : hovered.element
              })
            }
          }}
        />
      ) : null}

      {menu ? (
        <Suspense fallback={null}>
          <MenuPopup host={host} menu={menu} menuId={menuId} onClose={onClose} onChoose={onChoose} />
        </Suspense>
      ) : null}
    </>
  )
}
