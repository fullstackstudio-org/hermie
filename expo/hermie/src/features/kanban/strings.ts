/**
 * Every literal the Boards pages paint.
 *
 * Three of these carry an argument the screen cannot make on its own:
 *
 *  - `locked` says why three columns refuse a card. They belong to the
 *    dispatcher, and a UI that simply greyed them out would look broken.
 *  - `absent` is what a gateway without the plugin gets — the install command,
 *    not an empty board.
 *  - `noOrder` says why dragging a card up and down inside a column does
 *    nothing: there is no order to change, only a priority.
 */
import { localised } from '../../i18n/catalogue'

const kanbanStringsEn = {
  settings: {
    row: 'Boards',
    hint: 'The Kanban boards this gateway keeps'
  },

  /** The chat list's own entry, which is the same destination by another door. */
  menu: 'Boards',

  title: 'Boards',
  subtitle: 'Work your bots pick up.',
  back: 'Settings',

  loading: 'Reading the boards…',
  failed: (reason: string) => `Could not read the boards: ${reason}`,
  empty: 'This gateway has no boards yet.',
  emptyHint: 'Make one with `hermes kanban board create`, or from the Hermes desktop app.',

  /**
   * The plugin is not installed, or is switched off.
   *
   * Every Kanban route lives behind the plugin's own router, so the prefix
   * itself 404s and there is nothing to degrade to.
   */
  absent: 'This gateway has no Kanban plugin.',
  absentHint: 'Install it on the machine that runs the gateway:',
  absentCommand: 'hermes plugins install kanban',

  boardCards: (count: number) => `${count} ${count === 1 ? 'card' : 'cards'}`,

  board: {
    back: 'Boards',
    loading: 'Reading the board…',
    empty: 'Nothing on this board yet.',
    showArchived: 'Show archived',
    hideArchived: 'Hide archived',
    newCard: 'New card',
    columnEmpty: 'Nothing here.'
  },

  /** The eight fixed columns, under the names a reader would use for them. */
  columns: {
    triage: 'Triage',
    todo: 'To do',
    scheduled: 'Scheduled',
    ready: 'Ready',
    running: 'Running',
    blocked: 'Blocked',
    review: 'Review',
    done: 'Done',
    archived: 'Archived'
  } as Record<string, string>,

  /**
   * Why a column will not take a card.
   *
   * `running` and `review` are the dispatcher's, and `scheduled` needs a
   * wake-up time no client can attach. The sentence is said once, under the
   * move menu, rather than as a tooltip on three dead targets.
   */
  locked: 'Running, Review and Scheduled are the dispatcher’s. A card can leave them but not be put into them.',

  /** Why dragging inside a column does nothing. */
  noOrder: 'Cards are ordered by priority and age, so there is no order to drag within a column.',

  /**
   * How to move a card with the finger, said only where the finger can.
   *
   * On a stacked board the columns are screenfuls apart, so the hint would be
   * describing a gesture that is not there. The move menu is on every card on
   * every layout, which is why the drag can be a wide-window convenience
   * rather than the way this works.
   */
  dragHint: 'Hold a card to pick it up, then drop it on a column.',

  /** What a held card says to assistive technology, beside the Move to… button. */
  dragLabel: 'Hold to pick this card up, or use Move to…',

  /**
   * Aimed at a column the dispatcher owns.
   *
   * Refused here rather than by the gateway: upstream raises on `running`
   * before it looks at anything else, so this is a 400 the app can see coming.
   * The columns already read as non-targets while a card is in the air; this
   * is for the reader who let go on one anyway.
   */
  lockedTarget: (column: string) => `${column} is the dispatcher’s. A card cannot be put there.`,

  move: 'Move to…',
  moved: (column: string) => `Moved to ${column}.`,
  /**
   * The server applied a different column from the one that was asked for.
   *
   * A card leaving `running` is re-routed by `_retry_status_for_run`, so this
   * is an ordinary outcome and not a failure — but a reader who asked for
   * Ready and got Review needs telling.
   */
  movedElsewhere: (asked: string, got: string) => `Asked for ${asked}; the board put it in ${got}.`,
  moveRefused: (reason: string) => reason,

  card: {
    back: 'Board',
    title: 'Title',
    body: 'Notes',
    assignee: 'Assignee',
    priority: 'Priority',
    column: 'Column',
    created: 'Created',
    summary: 'LATEST SUMMARY',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved.',
    archive: 'Archive',
    archiving: 'Archiving…',
    archived: 'Archived.',
    archiveHint: 'Archiving keeps the card and its history. It is not a delete.'
  },

  comments: {
    header: 'COMMENTS',
    none: 'No comments yet.',
    placeholder: 'Add a comment',
    add: 'Comment',
    adding: 'Posting…'
  },

  create: {
    title: 'New card',
    titleField: 'Title',
    titlePlaceholder: 'What needs doing',
    bodyField: 'Notes',
    column: 'COLUMN',
    submit: 'Make the card',
    submitting: 'Making it…',
    /** `title` is the one required field on `CreateTaskBody`. */
    needsTitle: 'A card needs a title.'
  }
}

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `kanbanStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const kanbanStrings = localised('kanban', kanbanStringsEn)
