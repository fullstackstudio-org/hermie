/**
 * Settings, Chat list: the arrangement of the person's chats, in the store the `ui_meta` bridge mirrors
 * onto the gateway (`state/layout.ts`): the order, folders, each chat's colour, its mute and the
 * archive. It changes things through the store's actions and nothing else; the bridge notices every
 * change by diffing, sends it and dates it (README, "Settings that follow the person").
 *
 * **Reordering has two ways, and the keyboard's is not a copy of the pointer's.** A row's handle is
 * draggable (HTML drag and drop: drop on a chat to go before or after it, on a folder's row to go to
 * the end of that folder, and a folder moves among the top level the same way), and every row also has
 * Move up and Move down buttons, which are the operable-by-keyboard way and say where the row went in a
 * polite status line. The buttons stay in the tab order at the ends of a list (`aria-disabled`, not
 * `disabled`) so a step to the end does not throw the reader's focus away.
 *
 * **What else a row offers** is behind one button per row (Actions for <name>), a disclosure with
 * native controls: the folder it is in, its colour, its mute, and archive. A folder's own has its name,
 * colour and delete. Archived chats are listed apart and offer colour, mute and Unarchive.
 *
 * The page lists what the arrangement holds and the roster has not placed yet (no connection to fold it
 * in), loose and unmovable, so no chat is missing from it. The sidebar's own list does not draw the
 * arrangement yet; this is where it is changed.
 */
import { type DragEvent, type ReactElement, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { ACCENT_NAMES, type AccentName } from '../../state/folders'
import { botLabel, layoutStore } from '../../state/layout'
import { settingsStore } from '../../state/settings'
import { formatMuteUntil, MUTE_DURATIONS, type MuteDuration, muteUntil } from '../../state/mute'
import { Icon } from '../../ui/icons'
import { Button, VisuallyHidden } from '../../ui/primitives'
import { botNames } from '../bots/bot-names'
import {
  type Dragged,
  dropOf,
  folderStepOffset,
  looseChats,
  type Over,
  placementOf,
  stepOffset,
  type ViewEntry,
  viewOf
} from './arrangement-model'
import { SettingsPage, SyncNote } from './controls'
import './arrangement.css'

/** A mute select's value: `off`, `keep` (the deadline it already has), or a duration. */
type MuteChoice = 'off' | 'keep' | MuteDuration

const accentLabel = (accent: AccentName): string => strings.app.layout.accents[accent]

const folderTitle = (name: string): string => name || strings.app.layout.unnamedFolder

/** What every row needs and none of them owns: the page's state and the things it does. */
interface RowCommon {
  accents: Record<string, AccentName>
  mutes: Record<string, number>
  folders: { id: string; name: string }[]
  now: number
  nameOf: (bot: string) => string
  openKey: string | null
  setOpenKey: (key: string | null) => void
  dragging: Dragged | null
  mark: { key: string; after: boolean } | null
  startDrag: (event: DragEvent<HTMLElement>, dragged: Dragged) => void
  endDrag: () => void
  overRow: (event: DragEvent<HTMLElement>, key: string, over: (after: boolean) => Over) => void
  leaveRow: (key: string) => void
  dropRow: (event: DragEvent<HTMLElement>, over: (after: boolean) => Over) => void
  step: (name: string, direction: -1 | 1) => void
  stepFolder: (id: string, direction: -1 | 1) => void
  canStep: (name: string, direction: -1 | 1) => boolean
  canStepFolder: (id: string, direction: -1 | 1) => boolean
  setArchived: (name: string, archived: boolean) => void
  moveToFolder: (name: string, folderId: string | null) => void
  removeFolder: (id: string, name: string) => void
}

/** The element id of a row's step button, so the page can put the focus back on it after the row has moved. */
const stepId = (rowKey: string, direction: -1 | 1): string =>
  `arr-step-${encodeURIComponent(rowKey)}-${direction === -1 ? 'up' : 'down'}`

function StepButton({
  rowKey,
  direction,
  label,
  subject,
  disabled,
  onStep
}: {
  rowKey: string
  direction: -1 | 1
  label: string
  subject: string
  disabled: boolean
  onStep: () => void
}): ReactElement {
  return (
    <button
      type="button"
      id={stepId(rowKey, direction)}
      className="hm-arr__step"
      // Not `disabled`: a button that disables itself at the end of the list drops the focus the reader is using.
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) {
          onStep()
        }
      }}
    >
      <Icon name="chevronDown" size={18} {...(direction === -1 ? { className: 'hm-icon--up' } : {})} />
      <VisuallyHidden>
        {label} {subject}
      </VisuallyHidden>
    </button>
  )
}

function Grip({ common, item }: { common: RowCommon; item: Dragged }): ReactElement {
  return (
    <span
      className="hm-arr__grip"
      draggable
      title={sheetStrings.settings.chatList.dragHandle}
      aria-hidden="true"
      onDragStart={event => common.startDrag(event, item)}
      onDragEnd={common.endDrag}
    >
      <Icon name="grip" size={18} />
    </span>
  )
}

function ColourSelect({
  label,
  value,
  onChange
}: {
  label: string
  value: AccentName
  onChange: (accent: AccentName) => void
}): ReactElement {
  return (
    <label className="hm-arr__field">
      <span>{label}</span>
      <select value={value} onChange={event => onChange(event.currentTarget.value as AccentName)}>
        {ACCENT_NAMES.map(candidate => (
          <option key={candidate} value={candidate}>
            {accentLabel(candidate)}
          </option>
        ))}
      </select>
    </label>
  )
}

interface ChatRowProps {
  common: RowCommon
  name: string
  folderId: string | null
  archived: boolean
}

function ChatRow({ common, name, folderId, archived }: ChatRowProps): ReactElement {
  const label = common.nameOf(name)
  const accent = common.accents[name] ?? 'default'
  const until = common.mutes[name]
  const muted = until !== undefined && (until === 0 || until > common.now)
  const key = `chat:${name}`
  const open = common.openKey === key
  const panelId = `arr-panel-${encodeURIComponent(name)}`
  const actions = strings.app.layout.rowActions({ name: label })
  const words = sheetStrings.settings.chatList
  const choice: MuteChoice = !muted ? 'off' : until === 0 ? 'forever' : 'keep'
  const mark = common.mark?.key === key ? common.mark : null
  const over = (after: boolean): Over => ({ kind: 'chat', name, after })

  return (
    <li
      className="hm-arr__item"
      data-bot={name}
      data-dragging={common.dragging?.kind === 'chat' && common.dragging.name === name ? 'true' : undefined}
    >
      <div
        className="hm-arr__row"
        data-mark={mark ? (mark.after ? 'after' : 'before') : undefined}
        onDragOver={event => common.overRow(event, key, over)}
        onDragLeave={() => common.leaveRow(key)}
        onDrop={event => common.dropRow(event, over)}
      >
        {archived ? null : <Grip common={common} item={{ kind: 'chat', name }} />}
        <span className="hm-swatch" data-accent={accent} aria-hidden="true" />
        <span className="hm-arr__text">
          <span className="hm-arr__name">{label}</span>
          {muted && until !== undefined ? (
            <span className="hm-arr__badge">
              {until === 0
                ? strings.app.layout.muted
                : strings.app.layout.mutedUntil({
                    when: formatMuteUntil(until, common.now, strings.app.layout.muteWeekdays)
                  })}
            </span>
          ) : null}
        </span>
        {archived ? null : (
          <span className="hm-arr__steps">
            <StepButton
              rowKey={key}
              direction={-1}
              label={strings.app.layout.moveUp}
              subject={label}
              disabled={!common.canStep(name, -1)}
              onStep={() => common.step(name, -1)}
            />
            <StepButton
              rowKey={key}
              direction={1}
              label={strings.app.layout.moveDown}
              subject={label}
              disabled={!common.canStep(name, 1)}
              onStep={() => common.step(name, 1)}
            />
          </span>
        )}
        <button
          type="button"
          className="hm-arr__toggle"
          aria-expanded={open}
          {...(open ? { 'aria-controls': panelId } : {})}
          aria-label={actions}
          onClick={() => common.setOpenKey(open ? null : key)}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>

      {open ? (
        <div className="hm-arr__panel" id={panelId} role="group" aria-label={actions}>
          {archived ? null : (
            <label className="hm-arr__field">
              <span>{strings.app.layout.moveToFolderMenu}</span>
              <select
                value={folderId ?? ''}
                onChange={event => common.moveToFolder(name, event.currentTarget.value || null)}
              >
                <option value="">{strings.app.layout.topGroup}</option>
                {common.folders.map(folder => (
                  <option key={folder.id} value={folder.id}>
                    {folderTitle(folder.name)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <ColourSelect
            label={strings.app.layout.colour}
            value={accent}
            onChange={next => layoutStore.getState().setAccent(name, next)}
          />

          <label className="hm-arr__field">
            <span>{strings.app.layout.mute}</span>
            <select
              value={choice}
              onChange={event => {
                const next = event.currentTarget.value as MuteChoice

                if (next === 'keep') {
                  return
                }

                layoutStore.getState().setMute(name, next === 'off' ? null : muteUntil(next, common.now))
              }}
            >
              <option value="off">{strings.chat.options.notMuted}</option>
              {choice === 'keep' && until !== undefined ? (
                <option value="keep">
                  {words.muteKeep({ until: formatMuteUntil(until, common.now, strings.app.layout.muteWeekdays) })}
                </option>
              ) : null}
              {MUTE_DURATIONS.map(duration => (
                <option key={duration} value={duration}>
                  {strings.app.layout.muteFor[duration]}
                </option>
              ))}
            </select>
          </label>

          <Button variant="quiet" onClick={() => common.setArchived(name, !archived)}>
            {archived ? strings.app.layout.unarchive : strings.app.layout.archive}
            <VisuallyHidden>{label}</VisuallyHidden>
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function FolderNameField({ name, onCommit }: { name: string; onCommit: (name: string) => void }): ReactElement {
  const [draft, setDraft] = useState(name)

  // A rename that arrived from another device replaces what is shown.
  useEffect(() => setDraft(name), [name])

  const commit = (): void => {
    const trimmed = draft.trim()

    if (trimmed !== name) {
      onCommit(trimmed)
    }

    setDraft(trimmed)
  }

  return (
    <label className="hm-arr__field">
      <span>{strings.app.layout.folderName}</span>
      <input
        type="text"
        value={draft}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

function FolderRow({
  common,
  entry
}: {
  common: RowCommon
  entry: Extract<ViewEntry, { kind: 'folder' }>
}): ReactElement {
  const { folder } = entry
  const label = folderTitle(folder.name)
  const colour = folder.colour ?? 'default'
  const key = `folder:${folder.id}`
  const open = common.openKey === key
  const panelId = `arr-panel-${folder.id}`
  const actions = strings.app.layout.folderActions({ name: folder.name })
  const mark = common.mark?.key === key ? common.mark : null
  const over = (after: boolean): Over => ({ kind: 'folder', id: folder.id, after })

  return (
    <li
      className="hm-arr__item hm-arr__folder"
      data-folder={folder.id}
      data-dragging={common.dragging?.kind === 'folder' && common.dragging.id === folder.id ? 'true' : undefined}
    >
      <div
        className="hm-arr__row hm-arr__row--folder"
        data-mark={mark ? (mark.after ? 'after' : 'before') : undefined}
        onDragOver={event => common.overRow(event, key, over)}
        onDragLeave={() => common.leaveRow(key)}
        onDrop={event => common.dropRow(event, over)}
      >
        <Grip common={common} item={{ kind: 'folder', id: folder.id }} />
        <span className="hm-swatch" data-accent={colour} aria-hidden="true" />
        <span className="hm-arr__text">
          <span className="hm-arr__name">{label}</span>
        </span>
        <span className="hm-arr__steps">
          <StepButton
            rowKey={key}
            direction={-1}
            label={strings.app.layout.moveUp}
            subject={label}
            disabled={!common.canStepFolder(folder.id, -1)}
            onStep={() => common.stepFolder(folder.id, -1)}
          />
          <StepButton
            rowKey={key}
            direction={1}
            label={strings.app.layout.moveDown}
            subject={label}
            disabled={!common.canStepFolder(folder.id, 1)}
            onStep={() => common.stepFolder(folder.id, 1)}
          />
        </span>
        <button
          type="button"
          className="hm-arr__toggle"
          aria-expanded={open}
          {...(open ? { 'aria-controls': panelId } : {})}
          aria-label={actions}
          onClick={() => common.setOpenKey(open ? null : key)}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>

      {open ? (
        <div className="hm-arr__panel" id={panelId} role="group" aria-label={actions}>
          <FolderNameField name={folder.name} onCommit={name => layoutStore.getState().renameFolder(folder.id, name)} />

          <ColourSelect
            label={strings.app.layout.folderColour}
            value={colour}
            onChange={next => layoutStore.getState().setFolderColour(folder.id, next)}
          />

          <Button variant="quiet" data-tone="danger" onClick={() => common.removeFolder(folder.id, label)}>
            {strings.app.layout.deleteFolder}
            <VisuallyHidden>{label}</VisuallyHidden>
          </Button>
        </div>
      ) : null}

      {entry.chats.length === 0 ? (
        <p className="hm-arr__empty">{strings.app.layout.folderEmpty}</p>
      ) : (
        <ul className="hm-arr__list" aria-label={sheetStrings.settings.chatList.folderMembers({ name: label })}>
          {entry.chats.map(name => (
            <ChatRow key={name} common={common} name={name} folderId={folder.id} archived={false} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function Arrangement(): ReactElement {
  useLocale()

  const layout = useStore(
    layoutStore,
    useShallow(state => ({
      entries: state.entries,
      folders: state.folders,
      archived: state.archived,
      accents: state.accents,
      mutes: state.mutes,
      labels: state.labels
    }))
  )
  const bots = useStore(botsStore, state => state.bots)
  const nameOrder = useStore(settingsStore, state => state.botNameOrder)
  const hideHandle = useStore(settingsStore, state => state.hideHandleWhenNamed)

  const [openKey, setOpenKey] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [dragging, setDragging] = useState<Dragged | null>(null)
  const [mark, setMark] = useState<{ key: string; after: boolean } | null>(null)
  const [folderName, setFolderName] = useState('')
  /** Where the focus goes once the next render has drawn the list the thing it was on has moved to. */
  const refocus = useRef<'archived' | 'list' | null>(null)
  /**
   * The step button that was pressed. A row that moves is re-inserted by the browser, which drops the
   * focus it held, so the button is focused again once the page has drawn the row where it went.
   */
  const refocusStep = useRef<string | null>(null)
  const archivedHeading = useRef<HTMLHeadingElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  /** What is being dragged, read by the drag events of other rows without waiting for a render. */
  const dragged = useRef<Dragged | null>(null)

  const words = sheetStrings.settings.chatList
  const arrangement = { entries: layout.entries, folders: layout.folders }
  const view = viewOf(
    arrangement,
    layout.archived,
    bots.map(bot => bot.name)
  )
  const now = Math.floor(Date.now() / 1000)
  const displayNames = new Map(bots.map(bot => [bot.name, bot.displayName]))

  /** What a row is called here: the reader's own name for the bot, else the gateway's display name, else its handle (`bot-names.ts`). */
  const nameOf = (bot: string): string =>
    botNames({ name: bot, displayName: displayNames.get(bot), label: botLabel(layout, bot) }, nameOrder, hideHandle)
      .primary || words.unnamedChat

  const hidden = (name: string): boolean => Boolean(layout.archived[name])

  useEffect(() => {
    const stepped = refocusStep.current

    if (stepped !== null) {
      refocusStep.current = null
      document.getElementById(stepped)?.focus()
    }

    const target = refocus.current

    if (target === null) {
      return
    }

    refocus.current = null
    ;(target === 'archived' ? archivedHeading.current : listHeading.current)?.focus()
  })

  /** The container a chat is in, as the arrangement holds it (archived chats included). */
  const containerOf = (name: string): string[] =>
    layout.folders.find(candidate => candidate.bots.includes(name))?.bots ?? looseChats(arrangement)

  /**
   * Say, politely, where a row went. Read from the store after the change, so it is where the row is,
   * not where the page expected it to be. A chat that changed container is told which; one that stayed
   * in its own is told its place among those drawn.
   */
  const announce = (item: Dragged, fromFolder: string | null, stayed = false): void => {
    const state = layoutStore.getState()
    const placement = placementOf({ entries: state.entries, folders: state.folders }, state.archived, item)

    if (!placement) {
      return
    }

    const folderName = (id: string | null): string =>
      id === null
        ? strings.app.layout.topGroup
        : folderTitle(state.folders.find(folder => folder.id === id)?.name ?? '')

    if (item.kind === 'chat' && !stayed && placement.folderId !== fromFolder) {
      setMessage(words.inFolder({ name: nameOf(item.name), folder: folderName(placement.folderId) }))

      return
    }

    setMessage(
      words.position({
        name: item.kind === 'chat' ? nameOf(item.name) : folderName(item.id),
        index: placement.index,
        count: placement.count
      })
    )
  }

  const common: RowCommon = {
    accents: layout.accents,
    mutes: layout.mutes,
    folders: layout.folders.map(folder => ({ id: folder.id, name: folder.name })),
    now,
    nameOf,
    openKey,
    setOpenKey,
    dragging,
    mark,

    startDrag(event, item) {
      dragged.current = item
      setDragging(item)

      const transfer = event.dataTransfer

      if (transfer) {
        transfer.effectAllowed = 'move'
        // Firefox starts no drag without some data.
        transfer.setData('text/plain', item.kind === 'chat' ? item.name : item.id)

        const row = event.currentTarget.closest('li')

        if (row && typeof transfer.setDragImage === 'function') {
          transfer.setDragImage(row, 16, 16)
        }
      }
    },

    endDrag() {
      dragged.current = null
      setDragging(null)
      setMark(null)
    },

    overRow(event, key, over) {
      const item = dragged.current

      if (!item) {
        return
      }

      const box = event.currentTarget.getBoundingClientRect()
      const after = event.clientY >= box.top + box.height / 2

      // Nothing to commit on this half of the row: no drop line, and the browser keeps its "not allowed" cursor.
      if (dropOf(arrangement, item, over(after)) === null) {
        setMark(current => (current?.key === key ? null : current))

        return
      }

      event.preventDefault()

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move'
      }

      setMark(current => (current?.key === key && current.after === after ? current : { key, after }))
    },

    leaveRow(key) {
      setMark(current => (current?.key === key ? null : current))
    },

    dropRow(event, over) {
      const item = dragged.current

      if (!item) {
        return
      }

      event.preventDefault()

      const box = event.currentTarget.getBoundingClientRect()
      const drop = dropOf(arrangement, item, over(event.clientY >= box.top + box.height / 2))
      const before = placementOf(arrangement, layout.archived, item)

      dragged.current = null
      setDragging(null)
      setMark(null)

      if (!drop) {
        return
      }

      if (drop.kind === 'chat') {
        layoutStore.getState().dropBot(drop.name, drop.folderId, drop.index)
      } else {
        layoutStore.getState().dropFolder(drop.id, drop.index)
      }

      announce(item, before?.folderId ?? null)
    },

    canStep: (name, direction) => stepOffset(containerOf(name), hidden, name, direction) !== 0,

    step(name, direction) {
      const offset = stepOffset(containerOf(name), hidden, name, direction)

      if (offset === 0) {
        return
      }

      layoutStore.getState().moveBy(name, offset)
      refocusStep.current = stepId(`chat:${name}`, direction)
      announce({ kind: 'chat', name }, null, true)
    },

    canStepFolder: (id, direction) => folderStepOffset(arrangement, layout.archived, id, direction) !== 0,

    stepFolder(id, direction) {
      const offset = folderStepOffset(arrangement, layout.archived, id, direction)

      if (offset === 0) {
        return
      }

      layoutStore.getState().moveFolderBy(id, offset)
      refocusStep.current = stepId(`folder:${id}`, direction)
      announce({ kind: 'folder', id }, null, true)
    },

    setArchived(name, archived) {
      layoutStore.getState().setArchived(name, archived)
      setOpenKey(null)
      refocus.current = archived ? 'archived' : 'list'
      setMessage(archived ? words.archivedNow({ name: nameOf(name) }) : words.unarchivedNow({ name: nameOf(name) }))
    },

    moveToFolder(name, folderId) {
      const before = placementOf(arrangement, layout.archived, { kind: 'chat', name })

      layoutStore.getState().moveToFolder(name, folderId)
      announce({ kind: 'chat', name }, before?.folderId ?? null)
    },

    removeFolder(id, name) {
      layoutStore.getState().removeFolder(id)
      setOpenKey(null)
      refocus.current = 'list'
      setMessage(words.folderRemoved({ name }))
    }
  }

  const addFolder = (): void => {
    const name = folderName.trim()

    layoutStore.getState().addFolder(name)
    setFolderName('')
    setMessage(words.folderCreated({ name: folderTitle(name) }))
  }

  return (
    <SettingsPage title={sheetStrings.settings.title.chatList} lead={words.intro} className="hm-arr">
      <SyncNote />
      <p className="hm-set__hint" id="arr-drag-hint">
        {words.dragHint}
      </p>

      <div className="hm-arr__new" role="group" aria-label={words.newFolderHeading}>
        <label className="hm-arr__field">
          <span>{strings.app.layout.folderName}</span>
          <input
            type="text"
            value={folderName}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setFolderName(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addFolder()
              }
            }}
          />
        </label>
        <Button variant="quiet" onClick={addFolder}>
          {strings.app.layout.newFolder}
        </Button>
      </div>

      <h3 className="hm-settings-page__heading" ref={listHeading} tabIndex={-1}>
        {words.chatsHeading}
      </h3>

      {view.entries.length === 0 ? (
        <p className="hm-settings-page__text">{words.empty}</p>
      ) : (
        <ul className="hm-arr__list" aria-label={words.chatsHeading} aria-describedby="arr-drag-hint">
          {view.entries.map(entry =>
            entry.kind === 'folder' ? (
              <FolderRow key={`folder:${entry.id}`} common={common} entry={entry} />
            ) : (
              <ChatRow key={`chat:${entry.name}`} common={common} name={entry.name} folderId={null} archived={false} />
            )
          )}
        </ul>
      )}

      {view.archived.length > 0 ? (
        <>
          <h3 className="hm-settings-page__heading" ref={archivedHeading} tabIndex={-1}>
            {strings.app.layout.archived({ count: view.archived.length })}
          </h3>
          <p className="hm-set__hint">{strings.app.layout.archivedPreview}</p>
          <ul className="hm-arr__list" aria-label={strings.app.layout.archived({ count: view.archived.length })}>
            {view.archived.map(name => (
              <ChatRow
                key={name}
                common={common}
                name={name}
                folderId={layout.folders.find(folder => folder.bots.includes(name))?.id ?? null}
                archived
              />
            ))}
          </ul>
        </>
      ) : null}

      <p className="hm-settings-page__message" role="status">
        {message}
      </p>
    </SettingsPage>
  )
}
