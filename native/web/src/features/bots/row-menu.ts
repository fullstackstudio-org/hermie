/**
 * What a chat row can do, as data, and what each thing does (the Expo app's `row-menu-items.ts` and the
 * native app's `ChatRowActions`, which this follows): Mark as read, Edit profile, Pin, Mute, Move to folder,
 * Colour and Archive, in the order the owner asked for them.
 *
 * The menu is drawn from `rowMenuItems` and a choice is carried out by `runRowAction`, so there is one list
 * of intentions and no second table of what a row can do beside the drawing. Carrying out is the layout
 * store's own actions, the ones Settings, Chat list calls (`state/layout.ts`): nothing here keeps a rule of
 * its own about pins, mutes, folders or the archive.
 *
 * The menu has one level of depth. A line that opens a list of choices (Mute, Move to folder, Colour) is a
 * `submenu` and shows that list in place, under a Back line; a choice in it is a `radio` (the one in force is
 * `checked`) or an `action`.
 *
 * Only the menu's own chunk imports this (`RowMenu.tsx`): it reads the sheets' strings.
 */
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { ACCENT_NAMES, type AccentName } from '../../state/folders'
import type { ChatLayoutState } from '../../state/layout'
import { formatMuteUntil, MUTE_DURATIONS, type MuteDuration, muteUntil } from '../../state/mute'

export type RowMenuView = 'root' | 'mute' | 'colour' | 'folder'

/** What the menu needs to know about a row to say what it can do. */
export interface RowMenuModel {
  /** What the row is called, as it is drawn. */
  name: string
  accent: AccentName
  archived: boolean
  pinned: boolean
  /** The chat has something unread: Mark as read is on. */
  unread: boolean
  /** When the mute lapses (unix seconds), `0` for never, `null` for a chat that is not muted. */
  mutedUntil: number | null
  /** The clock the deadline is read against (unix seconds). */
  now: number
  /** The folder the chat is in, `null` for the top level. */
  folderId: string | null
  /** Every folder there is. */
  folders: readonly { id: string; name: string }[]
}

export type RowAction =
  | { kind: 'markRead' }
  | { kind: 'editProfile' }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'mute'; duration: MuteDuration }
  | { kind: 'unmute' }
  | { kind: 'folder'; folderId: string | null }
  | { kind: 'accent'; accent: AccentName }
  | { kind: 'archive'; archived: boolean }

export interface RowMenuItem {
  /** Unique in its view; the element's identity. */
  id: string
  /**
   * `action` does something and closes the menu; `submenu` shows another view; `radio` is one choice of a
   * list (`checked` says which is in force) and does something; `back` returns to the first view; `caption`
   * says something and cannot be chosen.
   */
  kind: 'action' | 'submenu' | 'radio' | 'back' | 'caption'
  label: string
  checked?: boolean
  disabled?: boolean
  action?: RowAction
  view?: RowMenuView
}

const folderTitle = (name: string): string => name || strings.app.layout.unnamedFolder

/** Mute, or the state of one: a line that opens the durations, or what the mute is and how to end it. */
function muteItems(model: RowMenuModel): RowMenuItem[] {
  if (model.mutedUntil === null) {
    return [{ id: 'mute', kind: 'submenu', label: strings.app.layout.mute, view: 'mute' }]
  }

  const when =
    model.mutedUntil === 0 ? '' : formatMuteUntil(model.mutedUntil, model.now, strings.app.layout.muteWeekdays)

  return [
    {
      id: 'muted',
      kind: 'caption',
      label: when ? strings.app.layout.mutedUntil({ when }) : strings.app.layout.muted
    },
    { id: 'unmute', kind: 'action', label: sheetStrings.rowMenu.unmute, action: { kind: 'unmute' } }
  ]
}

/**
 * The lines of one view of a row's menu.
 *
 * Mark as read comes first, because with Edit profile it is what somebody opens this menu for without
 * having thought about it; Edit profile is about the BOT, so it sits above everything that is about the
 * row. Pin sits directly above Mute (where the row sits, then whether it interrupts), Colour and Archive
 * last, with nothing destructive under them.
 */
export function rowMenuItems(view: RowMenuView, model: RowMenuModel): RowMenuItem[] {
  const back: RowMenuItem = { id: 'back', kind: 'back', label: sheetStrings.rowMenu.back }

  switch (view) {
    case 'mute':
      return [
        back,
        ...MUTE_DURATIONS.map<RowMenuItem>(duration => ({
          id: `mute:${duration}`,
          kind: 'action',
          label: strings.app.layout.muteFor[duration],
          action: { kind: 'mute', duration }
        }))
      ]

    case 'colour':
      return [
        back,
        ...ACCENT_NAMES.map<RowMenuItem>(accent => ({
          id: `accent:${accent}`,
          kind: 'radio',
          label: strings.app.layout.accents[accent],
          checked: accent === model.accent,
          action: { kind: 'accent', accent }
        }))
      ]

    case 'folder':
      return [
        back,
        {
          id: 'folder:top',
          kind: 'radio',
          label: strings.app.layout.topGroup,
          checked: model.folderId === null,
          action: { kind: 'folder', folderId: null }
        },
        ...model.folders.map<RowMenuItem>(folder => ({
          id: `folder:${folder.id}`,
          kind: 'radio',
          label: folderTitle(folder.name),
          checked: folder.id === model.folderId,
          action: { kind: 'folder', folderId: folder.id }
        }))
      ]

    case 'root':
      return [
        {
          id: 'markRead',
          kind: 'action',
          label: sheetStrings.rowMenu.markRead,
          disabled: !model.unread,
          action: { kind: 'markRead' }
        },
        { id: 'editProfile', kind: 'action', label: sheetStrings.rowMenu.editProfile, action: { kind: 'editProfile' } },
        {
          id: 'pin',
          kind: 'action',
          label: model.pinned ? sheetStrings.rowMenu.unpin : sheetStrings.rowMenu.pin,
          action: { kind: 'pin', pinned: !model.pinned }
        },
        ...muteItems(model),
        // The archive has no folders: an archived chat is filed where it was, and Unarchive returns it there.
        ...(model.folders.length > 0 && !model.archived
          ? [{ id: 'folder', kind: 'submenu', label: strings.app.layout.moveToFolderMenu, view: 'folder' } as const]
          : []),
        { id: 'colour', kind: 'submenu', label: strings.app.layout.colour, view: 'colour' },
        {
          id: 'archive',
          kind: 'action',
          label: model.archived ? strings.app.layout.unarchive : strings.app.layout.archive,
          action: { kind: 'archive', archived: !model.archived }
        }
      ]
  }
}

/** What carrying a choice out needs: the layout's actions, and the two things only the page can do. */
export interface RowActionContext {
  layout: Pick<ChatLayoutState, 'setPinned' | 'setMute' | 'moveToFolder' | 'setAccent' | 'setArchived'>
  /** Move the read watermark to now. */
  markRead: () => void
  /** Open the bot's profile. */
  editProfile: () => void
  /** The clock a new mute is counted from (unix seconds). */
  now: number
  /** The folders, to name the one a chat went to. */
  folders: readonly { id: string; name: string }[]
}

/**
 * Carry a choice out through the layout store's actions, and say, in a sentence, what happened (for a
 * polite live region: a row that is pinned or archived moves, and nothing else tells a screen reader).
 */
export function runRowAction(action: RowAction, bot: string, name: string, context: RowActionContext): string {
  const words = sheetStrings.rowMenu

  switch (action.kind) {
    case 'markRead':
      context.markRead()

      return words.markedRead({ name })

    case 'editProfile':
      context.editProfile()

      return ''

    case 'pin':
      context.layout.setPinned(bot, action.pinned)

      return action.pinned ? words.pinned({ name }) : words.unpinned({ name })

    case 'mute':
      context.layout.setMute(bot, muteUntil(action.duration, context.now))

      return words.muted({ name, duration: strings.app.layout.muteFor[action.duration] })

    case 'unmute':
      context.layout.setMute(bot, null)

      return words.unmuted({ name })

    case 'folder': {
      context.layout.moveToFolder(bot, action.folderId)

      const folder =
        action.folderId === null
          ? strings.app.layout.topGroup
          : folderTitle(context.folders.find(candidate => candidate.id === action.folderId)?.name ?? '')

      return sheetStrings.settings.chatList.inFolder({ name, folder })
    }

    case 'accent':
      context.layout.setAccent(bot, action.accent)

      return words.coloured({ name, colour: strings.app.layout.accents[action.accent] })

    case 'archive':
      context.layout.setArchived(bot, action.archived)

      return action.archived
        ? sheetStrings.settings.chatList.archivedNow({ name })
        : sheetStrings.settings.chatList.unarchivedNow({ name })
  }
}
