/**
 * `features/kanban/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { kanbanStrings } from '../../features/kanban/strings'
import type { Translation } from '../catalogue'

export const kanban: Translation<typeof kanbanStrings> = {
  settings: {
    hint: 'De Kanban-boards die deze gateway bijhoudt'
  },

  subtitle: 'Werk dat je bots oppakken.',
  back: 'Instellingen',

  loading: 'De boards lezen…',
  failed: (reason: string) => `Kon de boards niet lezen: ${reason}`,
  empty: 'Deze gateway heeft nog geen boards.',
  emptyHint: 'Maak er een met `hermes kanban board create`, of vanuit de Hermes-desktopapp.',

  absent: 'Deze gateway heeft geen Kanban-plugin.',
  absentHint: 'Installeer hem op de machine die de gateway draait:',

  boardCards: (count: number) => `${count} ${count === 1 ? 'kaart' : 'kaarten'}`,

  board: {
    loading: 'Het board lezen…',
    empty: 'Nog niets op dit board.',
    showArchived: 'Toon archief',
    hideArchived: 'Verberg archief',
    newCard: 'Nieuw',
    columnEmpty: 'Niets hier.'
  },

  // `Triage` en `Review` blijven staan: dat zijn in het Nederlands dezelfde
  // woorden. De zin onder `locked` noemt de kolommen zoals ze hier heten.
  columns: {
    todo: 'Te doen',
    scheduled: 'Ingepland',
    ready: 'Gereed',
    running: 'Bezig',
    blocked: 'Geblokkeerd',
    done: 'Klaar',
    archived: 'Gearchiveerd'
  },

  locked: 'Bezig, Review en Ingepland zijn van de dispatcher. Een kaart kan eruit, maar kan er niet in worden gezet.',

  noOrder: 'Kaarten staan op volgorde van prioriteit en ouderdom, dus binnen een kolom valt er niets te slepen.',

  dragHint: 'Houd een kaart vast om hem op te pakken en laat hem los op een kolom.',
  dragLabel: 'Houd vast om deze kaart op te pakken, of gebruik Verplaats naar…',
  lockedTarget: (column: string) => `${column} is van de dispatcher. Daar kan geen kaart in.`,
  move: 'Verplaats naar…',
  moved: (column: string) => `Verplaatst naar ${column}.`,
  movedElsewhere: (asked: string, got: string) => `Gevraagd om ${asked}; het board zette hem in ${got}.`,

  card: {
    title: 'Titel',
    body: 'Notities',
    assignee: 'Toegewezen aan',
    priority: 'Prioriteit',
    column: 'Kolom',
    created: 'Aangemaakt',
    summary: 'SAMENVATTING',
    save: 'Opslaan',
    saving: 'Opslaan…',
    saved: 'Opgeslagen.',
    archive: 'Archiveren',
    archiving: 'Archiveren…',
    archived: 'Gearchiveerd.',
    archiveHint: 'Archiveren bewaart de kaart en zijn geschiedenis. Het is geen verwijdering.'
  },

  comments: {
    header: 'REACTIES',
    none: 'Nog geen reacties.',
    placeholder: 'Een reactie toevoegen',
    add: 'Reageren',
    adding: 'Plaatsen…'
  },

  create: {
    title: 'Nieuwe kaart',
    titleField: 'Titel',
    titlePlaceholder: 'Wat er moet gebeuren',
    bodyField: 'Notities',
    column: 'KOLOM',
    submit: 'Kaart maken',
    submitting: 'Maken…',
    needsTitle: 'Een kaart heeft een titel nodig.'
  }
}
