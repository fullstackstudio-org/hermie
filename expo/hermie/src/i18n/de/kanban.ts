/**
 * `features/kanban/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { kanbanStrings } from '../../features/kanban/strings'
import type { Translation } from '../catalogue'

export const kanban: Translation<typeof kanbanStrings> = {
  settings: {
    hint: 'Die Kanban-Boards, die dieses Gateway führt'
  },

  subtitle: 'Arbeit, die deine Bots übernehmen.',
  back: 'Einstellungen',

  loading: 'Boards werden gelesen…',
  failed: (reason: string) => `Boards konnten nicht gelesen werden: ${reason}`,
  empty: 'Dieses Gateway hat noch keine Boards.',
  emptyHint: 'Leg eins mit `hermes kanban board create` an oder in der Hermes-Desktop-App.',

  absent: 'Dieses Gateway hat kein Kanban-Plugin.',
  absentHint: 'Installiere es auf der Maschine, die das Gateway ausführt:',

  boardCards: (count: number) => `${count} ${count === 1 ? 'Karte' : 'Karten'}`,

  board: {
    loading: 'Board wird gelesen…',
    empty: 'Auf diesem Board ist noch nichts.',
    // „Archiv zeigen“ / „Archiv ausblenden“ are a mismatched pair and the
    // second one overflows. „Mit“ and „Ohne“ toggle in the same width.
    showArchived: 'Mit Archiv',
    hideArchived: 'Ohne Archiv',
    // „Neue Karte“ overflows the English button; the screen is a board.
    newCard: 'Neu',
    columnEmpty: 'Nichts hier.'
  },

  columns: {
    todo: 'Zu tun',
    scheduled: 'Geplant',
    ready: 'Bereit',
    running: 'Läuft',
    blocked: 'Blockiert',
    // „Prüfung“ is a noun a column header has no room for; „Prüfen“ is the
    // same length as the English and reads as the step it names.
    review: 'Prüfen',
    done: 'Fertig',
    // „Archiviert“ overflows a column header; „Archiv“ is the place itself.
    archived: 'Archiv'
  },

  // The three column names here have to be the ones `columns` paints.
  locked:
    'Läuft, Prüfen und Geplant gehören dem Dispatcher. Eine Karte kann sie verlassen, aber nicht hineingelegt werden.',

  noOrder:
    'Karten sind nach Priorität und Alter sortiert; innerhalb einer Spalte gibt es also keine Reihenfolge zum Ziehen.',

  // „Verschieben nach…“ is twice the English label; the menu that opens lists
  // the columns, so the preposition carries nothing.
  dragHint: 'Halte eine Karte gedrückt, um sie aufzunehmen, und lass sie auf einer Spalte los.',
  dragLabel: 'Gedrückt halten, um diese Karte aufzunehmen, oder Verschieben… verwenden',
  lockedTarget: (column: string) => `${column} gehört dem Dispatcher. Dort kann keine Karte hin.`,
  move: 'Verschieben…',
  moved: (column: string) => `Nach ${column} verschoben.`,
  movedElsewhere: (asked: string, got: string) => `Angefragt war ${asked}; das Board hat sie in ${got} gelegt.`,

  card: {
    title: 'Titel',
    body: 'Notizen',
    assignee: 'Zuständig',
    priority: 'Priorität',
    column: 'Spalte',
    created: 'Erstellt',
    // „NEUESTE ZUSAMMENFASSUNG“ is nine characters longer than the English.
    summary: 'NEUESTER STAND',
    save: 'Speichern',
    saving: 'Speichert…',
    saved: 'Gespeichert.',
    archive: 'Archivieren',
    archiving: 'Wird archiviert…',
    archived: 'Archiviert.',
    archiveHint: 'Archivieren behält die Karte und ihren Verlauf. Es ist kein Löschen.'
  },

  comments: {
    header: 'KOMMENTARE',
    none: 'Noch keine Kommentare.',
    placeholder: 'Kommentar schreiben',
    // „Kommentieren“ overflows the button next to the field it submits.
    add: 'Senden',
    adding: 'Wird gesendet…'
  },

  create: {
    title: 'Neue Karte',
    titleField: 'Titel',
    titlePlaceholder: 'Was zu tun ist',
    bodyField: 'Notizen',
    column: 'SPALTE',
    submit: 'Karte anlegen',
    submitting: 'Wird angelegt…',
    needsTitle: 'Eine Karte braucht einen Titel.'
  }
}
