/**
 * A chat row's menu itself (`ChatList` places and opens it): a chunk of its own, fetched the first time
 * the reader points at a row's button or reaches for it, so the first screen does not carry it.
 *
 * What it offers is `row-menu.ts` (Mark as read, Edit profile, Pin, Mute, Move to folder, Colour, Archive)
 * and what a choice does is the layout store's own actions, the ones Settings, Chat list uses.
 *
 * The ARIA menu pattern: `role="menu"` of `menuitem`s, focused on its first line, the arrows, Home and End
 * move, Return or Space chooses, Escape and Tab close it and put focus back where it was. A line that opens
 * a list (Mute, Move to folder, Colour) shows that list in the same menu, under a Back line: Right opens it,
 * Left or Escape goes back to the line it came from. A line that cannot be chosen now (Mark as read with
 * nothing unread) stays, `aria-disabled`. It hangs under its button (or at the pointer), right-aligned,
 * flips above it at the bottom of the window, follows it while the list scrolls, and closes once the row has
 * left the window or a press lands elsewhere.
 *
 * What it says about the row is read from the stores when it opens and as they change (a mute that lapses
 * while it is open, a chat that arrives), never kept.
 */
import { lastMessageAt, unreadCountSince } from '@hermie/transcript'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from 'zustand'

import { readWatermark } from '../../core/chats/read-watermark'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { folderOf } from '../../state/folders'
import { layoutStore } from '../../state/layout'
import { mutedUntil } from '../../state/mute'
import { Icon } from '../../ui/icons'
import { botLabel } from './bot-label'
import {
  createFolderAround,
  type RowMenuItem,
  type RowMenuModel,
  type RowMenuView,
  rowMenuItems,
  runRowAction
} from './row-menu'
import './row-menu.css'

export interface RowMenuProps {
  bot: string
  /** The element the menu hangs from (the row's button, or the row). */
  anchor: HTMLElement
  /** Where the pointer opened it, in the window; the menu then hangs from there. */
  point?: { x: number; y: number } | undefined
  /** Which line is focused first. */
  start: 'first' | 'last'
  menuId: string
  /** Close it; `refocus` puts focus back where it was. */
  onClose: (refocus: boolean) => void
  /** Say, politely, what a choice did. */
  onAnnounce: (text: string) => void
  /** Open the bot's profile. */
  onEditProfile: (bot: string) => void
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** What the row's menu says about one bot, from the stores. */
function useRowModel(bot: string): RowMenuModel {
  const layout = useStore(
    layoutStore,
    useShallow(state => ({
      accent: state.accents[bot] ?? 'default',
      archived: Boolean(state.archived[bot]),
      pinned: Boolean(state.pinned[bot]),
      until: state.mutes[bot],
      folders: state.folders,
      entries: state.entries
    }))
  )
  const displayName = useStore(botsStore, state => state.byName[bot]?.displayName)
  const label = useStore(layoutStore, state => state.labels[bot])
  const lastActive = useStore(botsStore, state => state.byName[bot]?.canonical?.lastActive ?? 0)
  const lastSeen = useStore(botsStore, state => state.lastSeen[bot] ?? 0)
  const unreadMessages = useStore(chatsStore, state => {
    const chat = state.chats[bot]

    return chat ? unreadCountSince(chat, lastSeen) : 0
  })
  const now = nowSeconds()
  const muted = layout.until === undefined ? null : mutedUntil({ [bot]: layout.until }, bot, now)

  return {
    name: botLabel(label || displayName, bot),
    accent: layout.accent,
    archived: layout.archived,
    pinned: layout.pinned,
    unread: (lastActive > 0 && lastActive > lastSeen) || unreadMessages > 0,
    mutedUntil: muted,
    now,
    folderId: folderOf({ entries: layout.entries, folders: layout.folders }, bot),
    folders: layout.folders.map(folder => ({ id: folder.id, name: folder.name }))
  }
}

export function RowMenu({
  bot,
  anchor,
  point,
  start,
  menuId,
  onClose,
  onAnnounce,
  onEditProfile
}: RowMenuProps): ReactElement {
  useLocale()

  const model = useRowModel(bot)
  const [view, setView] = useState<RowMenuView>('root')
  /** The form that names a new folder is showing, in place of the lines. */
  const [naming, setNaming] = useState(false)
  const [folderName, setFolderName] = useState('')
  const nameField = useRef<HTMLInputElement>(null)
  /** The line of the first view that opened the list now showing, so Back returns focus to it. */
  const cameFrom = useRef<string | null>(null)
  const element = useRef<HTMLDivElement>(null)
  const items = rowMenuItems(view, model)

  // Placed through the CSSOM, as the message menu is: the policy refuses a style attribute.
  const place = useCallback((): boolean => {
    const node = element.current

    if (!node || !anchor.isConnected) {
      return false
    }

    const rect = anchor.getBoundingClientRect()
    const root = anchor.ownerDocument.documentElement
    const height = root.clientHeight || Number.POSITIVE_INFINITY

    if (rect.bottom < 0 || rect.top > height) {
      return false
    }

    const x = point ? point.x : rect.right
    const y = point ? point.y : rect.bottom
    const width = node.offsetWidth
    const tall = node.offsetHeight
    const below = y + 4
    const top = below + tall > height - 8 && y - tall - 4 > 8 ? y - tall - 4 : Math.max(8, below)
    const left = Math.max(8, Math.min(point ? x : x - width, (root.clientWidth || x) - width - 8))

    node.style.top = `${Math.round(top)}px`
    node.style.left = `${Math.round(left)}px`

    return true
  }, [anchor, point])

  const lines = (): HTMLElement[] =>
    Array.from(element.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? [])

  // Re-placed whenever the lines change (a list is taller or shorter than the first view), and focused on
  // the first line of whatever is showing. A radio list starts on the one in force.
  useLayoutEffect(() => {
    place()

    const all = lines()
    const checked = all.find(line => line.getAttribute('aria-checked') === 'true')
    const returning = cameFrom.current !== null && view === 'root'
    const target = returning
      ? all.find(line => line.dataset.item === cameFrom.current)
      : (checked ?? (start === 'first' || view !== 'root' ? all[0] : all[all.length - 1]))

    cameFrom.current = view === 'root' ? null : cameFrom.current
    ;(target ?? all[0])?.focus()
    // Only when the view changes: the lines do not steal focus back as the model re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // The name field takes the focus when the form opens; when it closes, the line that opened it does.
  const wasNaming = useRef(false)

  useLayoutEffect(() => {
    if (naming) {
      nameField.current?.focus()
    } else if (wasNaming.current) {
      lines()
        .find(line => line.dataset.item === 'folder:new')
        ?.focus()
    }

    wasNaming.current = naming
  }, [naming])

  useEffect(() => {
    place()
  })

  // A press anywhere else closes it; the list moving under it moves it, once a frame.
  useEffect(() => {
    const doc = anchor.ownerDocument
    const win = doc.defaultView
    let frame = 0

    const onPointer = (event: Event): void => {
      const node = event.target as Node | null

      // The row's own button toggles it, so its press is not "elsewhere".
      if (node && (element.current?.contains(node) || (node instanceof Element && node.closest('.hm-row__more')))) {
        return
      }

      onClose(false)
    }

    const follow = (): void => {
      if (frame || !win) {
        return
      }

      frame = win.requestAnimationFrame(() => {
        frame = 0

        if (!place()) {
          onClose(false)
        }
      })
    }

    doc.addEventListener('pointerdown', onPointer, true)
    doc.addEventListener('scroll', follow, true)
    win?.addEventListener('resize', follow)

    return () => {
      doc.removeEventListener('pointerdown', onPointer, true)
      doc.removeEventListener('scroll', follow, true)
      win?.removeEventListener('resize', follow)

      if (frame) {
        win?.cancelAnimationFrame(frame)
      }
    }
  }, [anchor, onClose, place])

  const markRead = (): void => {
    const chat = chatsStore.getState().chats[bot]
    const bots = botsStore.getState()
    const newest = Math.max(chat ? lastMessageAt(chat) : 0, bots.byName[bot]?.canonical?.lastActive ?? 0)

    // Under the bot's own key, which is the one the list's row reads its watermark from.
    bots.markSeen(bot, readWatermark(nowSeconds(), newest))
  }

  const choose = (item: RowMenuItem): void => {
    if (item.disabled || item.kind === 'caption') {
      return
    }

    if (item.kind === 'submenu' && item.view) {
      cameFrom.current = item.id
      setView(item.view)

      return
    }

    if (item.kind === 'back') {
      setView('root')

      return
    }

    if (!item.action) {
      return
    }

    if (item.action.kind === 'newFolder') {
      setFolderName('')
      setNaming(true)

      return
    }

    const said = runRowAction(item.action, bot, model.name, {
      layout: layoutStore.getState(),
      markRead,
      editProfile: () => onEditProfile(bot),
      now: nowSeconds(),
      folders: model.folders
    })

    // Edit profile leaves for another screen, which takes the focus; every other choice puts it back.
    onClose(item.action.kind !== 'editProfile')

    if (said) {
      onAnnounce(said)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const all = lines()
    const at = all.indexOf(event.target as HTMLElement)
    const move = (index: number): void => {
      event.preventDefault()
      all[(index + all.length) % all.length]?.focus()
    }

    // The list's own keys (the arrows between rows) are not this menu's.
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
        move(all.length - 1)
        break
      case 'ArrowRight': {
        const item = items.find(candidate => candidate.id === (event.target as HTMLElement).dataset.item)

        if (item?.kind === 'submenu') {
          event.preventDefault()
          choose(item)
        }

        break
      }
      case 'ArrowLeft':
        if (view !== 'root') {
          event.preventDefault()
          setView('root')
        }

        break
      case 'Escape':
        event.preventDefault()

        if (view !== 'root') {
          setView('root')
        } else {
          onClose(true)
        }

        break
      case 'Tab':
        event.preventDefault()
        onClose(true)
        break
      default:
        break
    }
  }

  const createFolder = (): void => {
    const said = createFolderAround(bot, model.name, folderName, layoutStore.getState())

    // The chat went into the folder: its row may have moved, so focus goes where the layer can find it.
    onClose(true)
    onAnnounce(said)
  }

  const title = strings.app.layout.rowActions({ name: model.name })

  if (naming) {
    return (
      <div
        className="hm-row-menu hm-row-menu--form"
        id={menuId}
        role="dialog"
        aria-label={strings.app.layout.newFolder}
        ref={element}
        onKeyDown={event => {
          // The list's own keys are not this form's.
          event.stopPropagation()

          if (event.key === 'Escape') {
            event.preventDefault()
            setNaming(false)
          }
        }}
        onContextMenu={event => event.preventDefault()}
      >
        <label className="hm-row-menu__field">
          <span>{strings.app.layout.folderName}</span>
          <input
            ref={nameField}
            type="text"
            value={folderName}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setFolderName(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                createFolder()
              }
            }}
          />
        </label>
        <div className="hm-row-menu__actions">
          <button type="button" className="hm-row-menu__button" data-primary="true" onClick={createFolder}>
            {sheetStrings.rowMenu.createFolder}
          </button>
          <button type="button" className="hm-row-menu__button" onClick={() => setNaming(false)}>
            {strings.app.common.cancel}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="hm-row-menu"
      id={menuId}
      role="menu"
      aria-label={title}
      ref={element}
      onKeyDown={onKeyDown}
      // The row's context-menu key and Shift+F10 bubble here from nowhere; a right-click inside is not a second menu.
      onContextMenu={event => event.preventDefault()}
    >
      {items.map(item => {
        const role = item.kind === 'radio' ? 'menuitemradio' : item.kind === 'caption' ? 'none' : 'menuitem'

        if (item.kind === 'caption') {
          return (
            <span key={item.id} className="hm-row-menu__caption" role="presentation">
              {item.label}
            </span>
          )
        }

        return (
          <button
            key={item.id}
            type="button"
            role={role}
            tabIndex={-1}
            className="hm-row-menu__item"
            data-item={item.id}
            data-kind={item.kind}
            aria-disabled={item.disabled ? 'true' : undefined}
            aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
            aria-checked={item.kind === 'radio' ? Boolean(item.checked) : undefined}
            onClick={() => choose(item)}
          >
            {item.kind === 'back' ? <Icon name="chevronLeft" size={16} /> : null}
            <span className="hm-row-menu__label">{item.label}</span>
            {item.kind === 'submenu' ? <Icon name="chevronRight" size={16} /> : null}
            {item.kind === 'radio' && item.checked ? <span className="hm-row-menu__check" aria-hidden="true" /> : null}
          </button>
        )
      })}
    </div>
  )
}
