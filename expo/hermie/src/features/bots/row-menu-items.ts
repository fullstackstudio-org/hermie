/**
 * What a chat row can do, as data.
 *
 * The native menu and the fallback sheet are two ways of drawing ONE list of
 * intentions, and this is that list. Keeping it here rather than inside either
 * drawing has a concrete payoff: the ids are a closed alphabet, so the thing that
 * reads a selection back is a parser with a total switch rather than a pile of
 * string comparisons spread across a component.
 *
 * The ids are structured on purpose — `accent:teal`, `folder:d3f` — because two
 * of the groups are open sets. Nine colours and any number of folders cannot be
 * enumerated in a union type, and a parser that splits on the first colon can
 * answer for both without the menu and the handler agreeing on an index.
 */
import { strings } from '../../i18n/strings'
import { formatMuteUntil, MUTE_DURATIONS, MUTE_FOREVER, type MuteDuration } from '../../store/mute'
import { menuItems, type MenuItem } from '../../ui/menu'
import { ACCENT_ORDER, type AccentName } from '../../ui/tokens'

export interface RowMenuModel {
  botName: string
  displayName: string
  accent: AccentName
  archived: boolean
  /** Greys out Mark as read for a row that has nothing unread. */
  unread: boolean
  /**
   * Whether this chat is held at the top of its container.
   *
   * A state rather than a capability, so the one line can say which way round
   * it is — the same reading Mute/Unmute takes two lines to give, and it can be
   * one here because a pin has no deadline to report.
   */
  pinned?: boolean
  /**
   * Every folder the row could move to; `null` is the loose top level.
   *
   * Optional the way `movable` is, and for the same reason: a caller with
   * nowhere to offer leaves it out and the menu simply has no Move to folder
   * line. This module is the menu as DATA and everything that draws one reads
   * it, so a model that merely says less must not be a model that throws.
   */
  folders?: readonly { id: string | null; name: string }[]
  /** False in the archive drawer, where up and down mean nothing. */
  movable?: boolean
  /**
   * When this chat's silence lapses, `MUTE_FOREVER` for never, `null` for a
   * chat that is not muted.
   *
   * A deadline rather than a boolean, because the menu has to say WHEN: a
   * reader who muted a chat two days ago on another device has no other way to
   * find out, and "Muted" with no end is the one thing they might reasonably
   * panic about.
   */
  mutedUntil?: number | null
  /** The clock the deadline is read against. Unix seconds. */
  now?: number
}

export type RowMenuAction =
  | { kind: 'open' }
  | { kind: 'markRead' }
  | { kind: 'accent'; accent: AccentName }
  | { kind: 'folder'; folderId: string | null }
  | { kind: 'move'; offset: number }
  /** A toggle, not a value: the menu already says which way round it is. */
  | { kind: 'pinToggle' }
  /** Open the bot's profile editor — the same sheet the chat header's pill opens. */
  | { kind: 'editProfile' }
  /** A toggle, not a value: the menu already says which way round it is. */
  | { kind: 'archiveToggle' }
  | { kind: 'newFolder' }
  | { kind: 'mute'; duration: MuteDuration }
  | { kind: 'unmute' }

const FOLDER_TOP = 'top'

/**
 * Mute, or the state of one, as the two or three lines it takes.
 *
 * A muted chat gets a DISABLED line saying when it comes back, and then Unmute.
 * A menu saying something rather than offering it is unusual enough to justify:
 * the deadline was set somewhere else, possibly on another device and possibly
 * days ago, and without it "Unmute" is a button whose effect the reader cannot
 * predict. The fallback sheet already draws a disabled item as plain faint text,
 * and UIKit draws it as a greyed line, so both read as a caption without either
 * being taught a new kind of row.
 */
function muteItems(model: { mutedUntil?: number | null; now?: number }): MenuItem[] {
  const until = model.mutedUntil

  if (until === undefined || until === null) {
    return [
      {
        id: 'mute',
        title: strings.layout.mute,
        systemImage: 'bell.slash',
        children: MUTE_DURATIONS.map<MenuItem>(duration => ({
          id: `mute:${duration}`,
          title: strings.layout.muteFor[duration]
        }))
      }
    ]
  }

  const when =
    until === MUTE_FOREVER
      ? ''
      : formatMuteUntil(until, model.now ?? Math.floor(Date.now() / 1000), strings.layout.muteWeekdays)

  return [
    { id: 'mutedState', title: when ? strings.layout.mutedUntil(when) : strings.layout.muted, disabled: true },
    { id: 'unmute', title: strings.layout.unmute, systemImage: 'bell' }
  ]
}

/**
 * The row's menu, in the order the owner asked for it.
 *
 * Open first because it is what the row already does on a click, and a context
 * menu whose first line is not the obvious one reads as a menu of exceptions.
 * Mark as read second, for the same reason: between them they are what somebody
 * opens this menu for without having thought about it.
 *
 * Then Edit profile, which is the one line here about the BOT rather than about
 * its row in this list — so it sits directly under the two obvious ones and
 * above everything that is about the row.
 *
 * Then the two ways a row's place in the list is changed and the one way it is
 * silenced: Mute, where it lives, and how to move it. Colour and Archive come
 * last, together, because both are ways of dressing or filing a row that is
 * otherwise unchanged — decoration has no business above the things somebody
 * came here to do, and Archive stays where it always was, at the bottom with
 * nothing destructive under it.
 */
export function rowMenuItems(model: RowMenuModel): MenuItem[] {
  const folders = (model.folders ?? []).map<MenuItem>(folder => ({
    id: `folder:${folder.id ?? FOLDER_TOP}`,
    title: folder.name || strings.layout.unnamedFolder
  }))

  return menuItems(
    { id: 'open', title: strings.layout.openChat, systemImage: 'bubble.left.and.bubble.right' },
    {
      id: 'markRead',
      title: strings.layout.markRead,
      systemImage: 'envelope.open',
      disabled: !model.unread
    },
    {
      id: 'editProfile',
      title: strings.botProfile.menuItem,
      systemImage: 'person.crop.circle'
    },
    /*
      Pin sits directly above Mute and the two placement lines, because it is
      the first of the four that are about this row's PLACE in the list rather
      than about the bot or the conversation. Above Mute specifically: pinning
      is the more often used of the two by some distance, and the group reads
      top-down from "where it sits" to "whether it interrupts".
    */
    {
      id: 'pin',
      title: model.pinned ? strings.layout.unpin : strings.layout.pin,
      systemImage: model.pinned ? 'pin.slash' : 'pin'
    },
    ...muteItems(model),
    folders.length > 0 && {
      id: 'folder',
      title: strings.layout.moveToFolderMenu,
      systemImage: 'folder',
      children: folders
    },
    model.movable !== false && {
      id: 'move',
      title: '',
      inline: true,
      children: [
        { id: 'move:-1', title: strings.layout.moveUp, systemImage: 'arrow.up' },
        { id: 'move:1', title: strings.layout.moveDown, systemImage: 'arrow.down' }
      ]
    },
    model.movable !== false && {
      id: 'newFolder',
      title: strings.layout.newFolder,
      systemImage: 'folder.badge.plus'
    },
    {
      id: 'colour',
      title: strings.layout.colour,
      systemImage: 'paintpalette',
      children: ACCENT_ORDER.map<MenuItem>(name => ({
        id: `accent:${name}`,
        title: strings.layout.accents[name],
        selected: name === model.accent
      }))
    },
    {
      id: 'archive',
      title: model.archived ? strings.layout.unarchive : strings.layout.archive,
      systemImage: model.archived ? 'tray.and.arrow.up' : 'archivebox'
    }
  )
}

/**
 * Read a selection back.
 *
 * `null` for anything this menu did not offer, which includes a submenu's own id.
 * UIKit never reports opening a submenu, but a fallback sheet built from the same
 * data could hand one over by accident, and a switch that silently did the wrong
 * thing with it would be worse than one that does nothing.
 */
export function parseRowMenuAction(id: string): RowMenuAction | null {
  const [head, ...rest] = id.split(':')
  const tail = rest.join(':')

  switch (head) {
    case 'open':
      return { kind: 'open' }

    case 'markRead':
      return { kind: 'markRead' }

    case 'newFolder':
      return { kind: 'newFolder' }

    case 'editProfile':
      return { kind: 'editProfile' }

    case 'accent':
      return (ACCENT_ORDER as readonly string[]).includes(tail) ? { kind: 'accent', accent: tail as AccentName } : null

    case 'folder':
      return tail ? { kind: 'folder', folderId: tail === FOLDER_TOP ? null : tail } : null

    case 'move': {
      const offset = Number(tail)

      return Number.isFinite(offset) && offset !== 0 ? { kind: 'move', offset } : null
    }

    case 'archive':
      return { kind: 'archiveToggle' }

    case 'pin':
      return { kind: 'pinToggle' }

    case 'mute':
      return (MUTE_DURATIONS as readonly string[]).includes(tail)
        ? { kind: 'mute', duration: tail as MuteDuration }
        : null

    case 'unmute':
      return { kind: 'unmute' }

    default:
      return null
  }
}

/** A folder's own menu. The same closed alphabet, one level up. */
export interface FolderMenuModel {
  name: string
  colour: AccentName
  /** When every chat inside is silent until, `null` when any of them is not. */
  mutedUntil?: number | null
  now?: number
}

export type FolderMenuAction =
  | { kind: 'newFolder' }
  | { kind: 'rename' }
  | { kind: 'colour'; accent: AccentName }
  | { kind: 'delete' }
  | { kind: 'mute'; duration: MuteDuration }
  | { kind: 'unmute' }
  /** One step up or down among the top-level entries. `-1` or `1`. */
  | { kind: 'move'; offset: number }

/**
 * What a folder can do.
 *
 * Delete is last and destructive, and it is the only line here whose wording
 * has to promise something: the chats inside come back to the top level, so the
 * label says "folder" rather than naming them, and nothing in this menu offers
 * to delete a chat because nothing in the app does.
 *
 * Mute is the row menu's four spans applied to every chat inside at once, which
 * is why the ids are the same and the parser below is a near-twin. Two parsers
 * rather than one shared switch, because the two menus answer to different
 * handlers and a shared alphabet with two meanings is how a colour lands on the
 * wrong thing.
 */
export function folderMenuItems(model: FolderMenuModel): MenuItem[] {
  return menuItems(
    { id: 'rename', title: strings.layout.rename, systemImage: 'pencil' },
    {
      id: 'colour',
      title: strings.layout.folderColour,
      systemImage: 'paintpalette',
      children: ACCENT_ORDER.map<MenuItem>(name => ({
        id: `accent:${name}`,
        title: strings.layout.accents[name],
        selected: name === model.colour
      }))
    },
    ...muteItems(model).map<MenuItem>(item =>
      item.id === 'mute'
        ? { ...item, title: strings.layout.muteFolder }
        : item.id === 'unmute'
          ? { ...item, title: strings.layout.unmuteFolder }
          : item
    ),
    { id: 'newFolder', title: strings.layout.newFolder, systemImage: 'folder.badge.plus' },
    // The same pair the chat rows carry, and here for the same reason: the grip
    // is a gesture, and a mouse, a keyboard and a screen reader all need a way
    // to reorder that is not one.
    { id: 'move:-1', title: strings.layout.moveUp, systemImage: 'arrow.up' },
    { id: 'move:1', title: strings.layout.moveDown, systemImage: 'arrow.down' },
    { id: 'delete', title: strings.layout.deleteFolder, systemImage: 'trash', destructive: true }
  )
}

export function parseFolderMenuAction(id: string): FolderMenuAction | null {
  const [head, ...rest] = id.split(':')
  const tail = rest.join(':')

  switch (head) {
    case 'rename':
      return { kind: 'rename' }

    case 'delete':
      return { kind: 'delete' }

    case 'newFolder':
      return { kind: 'newFolder' }

    case 'move':
      return tail === '-1' || tail === '1' ? { kind: 'move', offset: Number(tail) } : null

    case 'accent':
      return (ACCENT_ORDER as readonly string[]).includes(tail) ? { kind: 'colour', accent: tail as AccentName } : null

    case 'mute':
      return (MUTE_DURATIONS as readonly string[]).includes(tail)
        ? { kind: 'mute', duration: tail as MuteDuration }
        : null

    case 'unmute':
      return { kind: 'unmute' }

    default:
      return null
  }
}
