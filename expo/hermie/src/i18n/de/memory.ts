/**
 * `features/memory/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { memoryStrings } from '../../features/memory/strings'
import type { Translation } from '../catalogue'

export const memory: Translation<typeof memoryStrings> = {
  title: 'Gedächtnis',
  rowTitle: 'Gedächtnis',
  rowHint: 'Was sich dieser Bot über seine Arbeit und über dich merkt.',
  botsTitle: 'Gedächtnis',
  botsHint: 'Lies und bearbeite, was sich jeder Bot merkt.',
  botsEmpty: 'Noch keine Bots.',
  forBot: (name: string) => `Gedächtnis von ${name}`,

  tabs: {
    entries: 'Einträge',
    raw: 'Roh'
  },

  // `sections` keeps MEMORY and USER: the two headers name MEMORY.md and
  // USER.md, and a file name is not translated. The FEATURE is Gedächtnis.
  sectionHint: {
    memory: 'Was der Bot über seine Arbeit notiert hat. Das MEMORY.md von Hermes.',
    user: 'Was der Bot über dich notiert hat. USER.md.'
  },

  loading: 'Gedächtnis wird gelesen…',
  empty: {
    memory: 'Noch nichts notiert.',
    user: 'Noch nichts über dich notiert.'
  },
  failed: (reason: string) => `Dieses Gedächtnis konnte nicht gelesen werden: ${reason}`,
  retry: 'Erneut versuchen',

  usage: (chars: number, limit: number) => `${chars} von ${limit} Zeichen`,
  usageUnbounded: (chars: number) => `${chars} Zeichen`,
  usageLabel: (target: string, percent: number) => `${target} ist zu ${percent}% voll`,

  search: {
    placeholder: 'In diesem Gedächtnis suchen',
    clear: 'Leeren',
    searching: 'Sucht…',
    none: (query: string) => `Nichts passt zu „${query}“.`,
    count: (found: number) => (found === 1 ? '1 Eintrag' : `${found} Einträge`),
    hint: 'Jedes Wort muss irgendwo im Eintrag vorkommen. Die Reihenfolge spielt keine Rolle.'
  },

  add: {
    placeholder: 'Etwas notieren',
    action: 'Hinzufügen',
    label: (target: string) => `Zu ${target} hinzufügen`
  },

  edit: {
    // „Bearbeiten“ is more than twice the English label; „Ändern“ is the short
    // German verb for the same button.
    action: 'Ändern',
    save: 'Ersetzen',
    cancel: 'Abbrechen',
    label: (index: number) => `Eintrag ${index + 1} bearbeiten`
  },

  remove: {
    action: 'Entfernen',
    label: (index: number) => `Eintrag ${index + 1} entfernen`,
    confirmTitle: 'Diesen Eintrag entfernen?',
    confirmBody: 'Dem Bot wird das nicht mehr mitgegeben. Hermes führt keine Historie einer Gedächtnisdatei.',
    confirm: 'Entfernen',
    cancel: 'Behalten'
  },

  // `memory.edit` is a configuration key and stays as it is written there.
  readOnly:
    'Dieses Gateway lässt das Gedächtnis lesen, aber nicht schreiben. Schalte memory.edit des Plugins für dieses Profil ein, um das zu ändern.',

  graph: {
    label: 'Eine Karte dieses Gedächtnisses: der Bot, seine Einträge und die Themen, die sie teilen',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    reset: 'Zurücksetzen',
    empty: 'Noch nichts zu zeichnen.',
    loading: 'Wird gezeichnet…',
    truncated: (shown: number, total: number) =>
      `${shown} von ${total} Einträgen. Der Rest ist nicht auf dieser Seite der Karte.`,
    dropped: (count: number) => `${count} weitere Knoten wurden nicht gezeichnet.`,
    full: {
      open: 'Im Vollbild öffnen',
      title: 'Gedächtniskarte',
      close: 'Schließen',
      dismiss: 'Die Karte schließen'
    },
    detail: {
      profile: 'Dieser Bot',
      topic: 'Thema',
      entry: 'Eintrag',
      // „ERWÄHNUNGEN“ overflows the English header; what the panel lists under
      // it are the entry's topics, which is what the German header says.
      topics: 'THEMEN',
      noTopics: 'Keine Themen in diesem Eintrag.',
      open: 'In der Liste zeigen',
      close: 'Schließen'
    }
  },

  raw: {
    loading: 'Es wird gelesen, was jedes Backend enthält…',
    readOnly: 'Nur lesen. Einträge werden im Reiter Einträge bearbeitet.',
    emptyDocument: 'Dieses hier ist leer.',
    truncated: 'Das Gateway hat nur den Anfang davon geschickt.',
    chars: (chars: number) => `${chars} ${chars === 1 ? 'Zeichen' : 'Zeichen'}`,
    unavailable: 'Dieses Backend gibt es auf diesem Gateway nicht.',
    notListable: 'Dieses Backend kann nicht sagen, was es enthält.',
    none: 'Dieses Gateway hat kein Gedächtnis-Backend genannt.',
    missing: 'Das Hermie-Plugin dieses Gateways liefert kein rohes Gedächtnis aus.',
    missingHint: 'Aktualisiere das Plugin auf der Maschine, die das Gateway ausführt:'
  },

  providers: {
    header: 'PROVIDER',
    notBrowsable: 'Nicht einsehbar',
    hint: 'Ein externer Gedächtnis-Provider antwortet einem Bot mit Text für einen Zug. Er bietet keinen Aufruf, der auflistet, was er enthält — hier gibt es also nichts zu zeigen.'
  },

  missing: {
    title: 'Das Hermie-Plugin hat keinen Gedächtnis-Browser',
    body: 'Um das Gedächtnis eines Bots zu lesen, braucht es das hermie-Plugin in Version 0.5.0 oder neuer, auf dem Gateway installiert und für dieses Profil aktiviert.',
    install: 'AUF DEM GATEWAY',
    guide: 'Zur Anleitung',
    unknown: 'Warten darauf, dass das Gateway sagt, was installiert ist…'
  }
}
