/**
 * `features/cron/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { cronStrings } from '../../features/cron/strings'
import type { Translation } from '../catalogue'

export const cron: Translation<typeof cronStrings> = {
  subtitle: 'Ein bisschen Fortschritt, immer wieder.',
  sections: {
    active: 'AKTIV',
    // „PAUSIERT“ is two characters longer than the English header it replaces.
    // „PAUSE“ says the same thing in a heading and stays inside it.
    paused: 'PAUSE'
  },
  list: {
    // „Neuer Cron“ overflows the English button; on a screen titled Crons the
    // noun is already on the reader's side of it.
    add: 'Neu',
    empty: 'Noch keine Crons. Leg einen an, damit ein Bot arbeitet, während du weg bist.',
    loading: 'Crons werden geladen…',
    failed: (reason: string) => `Crons konnten nicht geladen werden: ${reason}`,
    nextRun: (when: string) => `Als Nächstes: ${when}`,
    // Both micro labels stand for „Lauf“ and stay lower case, as the English does.
    nextLabel: 'nächster',
    lastLabel: 'letzter',
    overdue: 'Überfällig',
    neverRun: 'Nie gelaufen',
    noNextRun: 'Nicht geplant',
    lastRun: (when: string) => `Zuletzt gelaufen ${when}`,
    refreshedNever: 'Noch nicht aktualisiert',
    refreshedAt: (when: string) => `Aktualisiert ${when}`,
    profile: (name: string) => `Profil: ${name}`
  },
  gatewayBanner: 'Crons laufen nicht: der Hermes-Gateway-Prozess läuft nicht',
  status: {
    ok: 'Erfolgreich',
    failed: 'Fehlgeschlagen',
    paused: 'Pausiert',
    pending: 'Wartet',
    running: 'Läuft'
  },
  detail: {
    // „NÄCHSTER LAUF“ is half again as long as the English header; „GEPLANT“
    // fits and says the same about a time that has not arrived.
    nextRun: 'GEPLANT',
    instructions: 'Anweisungen',
    noPrompt: 'Dieser Cron führt ein Skript aus und hat keinen Prompt.',
    schedule: 'Zeitplan',
    scheduleLabel: 'Zeitplan',
    deliverLabel: 'Geht an',
    repeatLabel: 'Wiederholung',
    repeatForever: 'Bis zum Löschen',
    modelLabel: 'Modell',
    stateLabel: 'Zustand',
    lastRunLabel: 'Letzter Lauf',
    lastStatusLabel: 'Letzter Status',
    pausedReasonLabel: 'Pausiert wegen',
    errorLabel: 'Letzter Fehler',
    actions: 'AKTIONEN',
    // „Jetzt starten“ overflows the button; on the cron's own screen „Starten“
    // is unambiguous and the same length as the English.
    runNow: 'Starten',
    running: 'Startet…',
    // „Fortsetzen“ overflows; „Weiter“ is what a German control says here.
    resume: 'Weiter',
    // „Bearbeiten“ is more than twice the English label. „Ändern“ is the short
    // German verb for the same button.
    edit: 'Ändern',
    delete: 'Löschen',
    // „LAUFVERLAUF“ is a compound nobody says; „VERLAUF“ is the history.
    runHistory: 'VERLAUF',
    noRuns: 'Dieser Cron ist noch nicht gelaufen.',
    runsFailed: (reason: string) => `Der Verlauf konnte nicht geladen werden: ${reason}`,
    loadingRuns: 'Läufe werden geladen…',
    loading: 'Wird geladen…'
  },
  confirmRun: {
    // „CRON STARTEN“ overflows the eyebrow; the sheet's title names the cron.
    eyebrow: 'STARTEN',
    title: (name: string) => `„${name}“ jetzt starten?`,
    body: 'Der Cron läuft einmal, sofort, und liefert dorthin, wohin er sonst auch liefert. Sein Zeitplan bleibt unverändert.',
    confirm: 'Starten',
    cancel: 'Abbrechen'
  },
  confirmDelete: {
    eyebrow: 'LÖSCHEN',
    title: (name: string) => `„${name}“ löschen?`,
    body: 'Der Zeitplan wird vom Gateway entfernt. Bereits aufgezeichnete Lauf-Transkripte bleiben, wo sie sind.',
    confirm: 'Löschen',
    cancel: 'Behalten'
  },
  run: {
    title: 'Lauf',
    empty: 'Dieser Lauf hat keine Nachrichten aufgezeichnet.',
    failed: (reason: string) => `Dieser Lauf konnte nicht geladen werden: ${reason}`,
    loading: 'Lauf wird geladen…',
    readOnly: 'Nur lesen: Ein Cron-Lauf lässt sich von hier aus nicht fortsetzen.'
  },
  editor: {
    what: 'Was er tut',
    where: 'Wohin es geht',
    createTitle: 'Neuer Cron',
    editTitle: 'Cron bearbeiten',
    namePlaceholder: 'Morgenbriefing',
    prompt: 'Anweisungen',
    promptPlaceholder: 'Fasse die Neuigkeiten der Nacht zusammen und nenne drei Erkenntnisse.',
    deliver: 'Geht an',
    deliverLocal: 'Lokal (nur speichern)',
    profile: 'Profil',
    profileHint: 'In wessen Cron-Speicher der Job geschrieben wird. Er läuft als dieser Bot.',
    profileDefault: 'Dieses Gateway',
    profileLocked: 'Ein Cron lässt sich nach dem Anlegen nicht in ein anderes Profil verschieben.',
    schedule: 'Zeitplan',
    preview: (schedule: string) => `Geht so an das Gateway: ${schedule}`,
    nextRunHint: 'Das Gateway bestimmt den nächsten Lauf; er erscheint hier, sobald gespeichert ist.',
    save: 'Speichern',
    // „Wird gespeichert…“ is more than twice the English state label.
    saving: 'Speichert…',
    cancel: 'Abbrechen',
    nameRequired: 'Gib dem Cron einen Namen.',
    promptRequired: 'Schreib die Anweisungen, denen der Bot folgen soll.',
    saveFailed: (reason: string) => `Das Gateway hat den Cron abgelehnt: ${reason}`
  },
  schedule: {
    mode: 'Wiederholung',
    // Four options share one segmented row; „Intervall“ is the longest of the
    // four at nine characters and still fits the ~80pt a phone gives each.
    modes: {
      interval: 'Intervall',
      daily: 'Täglich',
      once: 'Einmal'
    },
    everyLabel: 'Alle',
    units: {
      minutes: 'Minuten',
      hours: 'Stunden',
      days: 'Tage'
    },
    time: 'Uhrzeit',
    days: 'Tage',
    daysHint: 'Kein Tag ausgewählt heißt: jeden Tag.',
    cronExpression: 'Cron-Ausdruck',
    cronHint: 'Fünf Felder: Minute, Stunde, Tag des Monats, Monat, Wochentag.',
    once: 'Wann',
    onceHint: 'Eine Verzögerung wie „in 2h“ oder ein Datum mit Uhrzeit wie 2026-09-20T09:00.',
    // Two letters rather than one: German weekday initials collide three times
    // over (Montag/Mittwoch, Dienstag/Donnerstag, Samstag/Sonntag), and a day
    // picker that shows the same letter twice cannot be read.
    weekdayInitials: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    weekdayNames: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
    errors: {
      interval: 'Gib an, wie viele Minuten, Stunden oder Tage zwischen den Läufen liegen.',
      time: 'Gib eine Uhrzeit als HH:MM an, zum Beispiel 09:00.',
      cronFieldCount: 'Ein Cron-Ausdruck hat fünf Felder, zum Beispiel 0 9 * * 1-5.',
      cronField: (field: string, value: string) => `Das Feld ${field} akzeptiert „${value}“ nicht.`,
      once: 'Gib eine Verzögerung wie „in 2h“ an oder ein Datum mit Uhrzeit wie 2026-09-20T09:00.'
    }
  },
  relative: {
    now: 'jetzt',
    secondsAgo: (value: number) => `vor ${value}s`,
    minutesAgo: (value: number) => `vor ${value} min`,
    hoursAgo: (value: number) => `vor ${value}h`,
    daysAgo: (value: number) => `vor ${value}d`
  }
}
