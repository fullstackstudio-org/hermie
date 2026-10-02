/**
 * `features/cron/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 *
 * Eén woord is door de hele tabel vastgehouden: een `run` is een **uitvoering**.
 * "Run" laten staan zou de lezer twee woorden voor hetzelfde geven, en de
 * knoppen eromheen ("Start nu") vragen toch al om een Nederlands werkwoord.
 */
import type { cronStrings } from '../../features/cron/strings'
import type { Translation } from '../catalogue'

export const cron: Translation<typeof cronStrings> = {
  subtitle: 'Een beetje vooruitgang, op herhaling.',
  sections: {
    active: 'ACTIEF',
    // "GEPAUZEERD" is het woord uit de woordenlijst, maar een sectiekop mag niet
    // langer worden dan het Engels. Als status (status.paused) staat het er wel.
    paused: 'PAUZE'
  },
  list: {
    add: 'Nieuw',
    empty: 'Nog geen crons. Maak er een om een bot te laten werken terwijl je weg bent.',
    loading: 'Crons laden…',
    failed: (reason: string) => `Kon de crons niet laden: ${reason}`,
    nextRun: (when: string) => `Volgende: ${when}`,
    nextLabel: 'volgende',
    lastLabel: 'laatste',
    overdue: 'Te laat',
    neverRun: 'Nooit uitgevoerd',
    noNextRun: 'Niet ingepland',
    lastRun: (when: string) => `Laatst uitgevoerd ${when}`,
    refreshedNever: 'Nog niet ververst',
    refreshedAt: (when: string) => `Ververst ${when}`,
    profile: (name: string) => `Profiel: ${name}`
  },
  gatewayBanner: 'Crons draaien niet: het gatewayproces van Hermes draait niet',
  status: {
    ok: 'Gelukt',
    failed: 'Mislukt',
    paused: 'Gepauzeerd',
    pending: 'Wachten',
    running: 'Bezig'
  },
  detail: {
    nextRun: 'VOLGENDE',
    instructions: 'Instructies',
    noPrompt: 'Deze cron draait een script en heeft geen prompt.',
    schedule: 'Schema',
    scheduleLabel: 'Schema',
    deliverLabel: 'Gaat naar',
    repeatLabel: 'Herhaling',
    repeatForever: 'Tot je hem verwijdert',
    stateLabel: 'Status',
    lastRunLabel: 'Laatst uitgevoerd',
    lastStatusLabel: 'Laatste status',
    pausedReasonLabel: 'Gepauzeerd omdat',
    errorLabel: 'Laatste fout',
    actions: 'ACTIES',
    runNow: 'Start nu',
    running: 'Starten…',
    pause: 'Pauze',
    resume: 'Hervatten',
    edit: 'Bewerken',
    delete: 'Verwijderen',
    runHistory: 'HISTORIE',
    noRuns: 'Deze cron is nog niet uitgevoerd.',
    runsFailed: (reason: string) => `Kon de historie niet laden: ${reason}`,
    loadingRuns: 'Uitvoeringen laden…',
    loading: 'Laden…'
  },
  confirmRun: {
    eyebrow: 'CRON STARTEN',
    title: (name: string) => `“${name}” nu uitvoeren?`,
    body: 'De cron draait één keer, meteen, en levert af waar hij normaal aflevert. Zijn schema verandert niet.',
    confirm: 'Start nu',
    cancel: 'Annuleren'
  },
  confirmDelete: {
    eyebrow: 'VERWIJDEREN',
    title: (name: string) => `“${name}” verwijderen?`,
    body: 'Het schema wordt van de gateway verwijderd. Al opgenomen transcripten blijven staan.',
    confirm: 'Verwijderen',
    cancel: 'Behouden'
  },
  run: {
    title: 'Uitvoering',
    empty: 'Deze uitvoering heeft geen berichten opgeleverd.',
    failed: (reason: string) => `Kon deze uitvoering niet laden: ${reason}`,
    loading: 'De uitvoering laden…',
    readOnly: 'Alleen-lezen: een cron-uitvoering kan hiervandaan niet worden voortgezet.'
  },
  editor: {
    what: 'Wat hij doet',
    where: 'Waar het heen gaat',
    createTitle: 'Nieuwe cron',
    editTitle: 'Cron bewerken',
    name: 'Naam',
    namePlaceholder: 'Ochtendbriefing',
    prompt: 'Instructies',
    promptPlaceholder: 'Vat de updates van vannacht samen en noem drie conclusies.',
    deliver: 'Gaat naar',
    deliverLocal: 'Lokaal (alleen opslaan)',
    profile: 'Profiel',
    profileHint: 'Bij welke bot de cron wordt opgeslagen. Hij draait ook als die bot.',
    profileDefault: 'Deze gateway',
    profileLocked: 'Een cron kan na het aanmaken niet naar een ander profiel worden verplaatst.',
    schedule: 'Schema',
    preview: (schedule: string) => `Gaat zo naar de gateway: ${schedule}`,
    nextRunHint: 'De gateway bepaalt de volgende uitvoering; die verschijnt hier zodra je hebt opgeslagen.',
    save: 'Opslaan',
    saving: 'Opslaan…',
    cancel: 'Annuleren',
    nameRequired: 'Geef de cron een naam.',
    promptRequired: 'Schrijf op welke instructies de bot moet volgen.',
    saveFailed: (reason: string) => `De gateway weigerde de cron: ${reason}`
  },
  schedule: {
    mode: 'Herhaling',
    modes: {
      daily: 'Dagelijks',
      once: 'Eenmalig'
    },
    everyLabel: 'Elke',
    units: {
      minutes: 'minuten',
      hours: 'uur',
      days: 'dagen'
    },
    time: 'Tijd',
    days: 'Dagen',
    daysHint: 'Geen dag gekozen betekent elke dag.',
    cronExpression: 'Cron-expressie',
    cronHint: 'Vijf velden: minuut, uur, dag van de maand, maand, dag van de week.',
    once: 'Wanneer',
    onceHint: 'Een vertraging zoals “in 2h”, of een datum en tijd zoals 2026-09-20T09:00.',
    weekdayInitials: ['Z', 'M', 'D', 'W', 'D', 'V', 'Z'],
    weekdayNames: ['Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag'],
    errors: {
      interval: 'Vul in hoeveel minuten, uren of dagen er tussen twee uitvoeringen zitten.',
      time: 'Vul een tijd in als HH:MM, bijvoorbeeld 09:00.',
      cronFieldCount: 'Een cron-expressie heeft vijf velden, bijvoorbeeld 0 9 * * 1-5.',
      cronField: (field: string, value: string) => `Het veld ${field} accepteert “${value}” niet.`,
      once: 'Vul een vertraging in zoals “in 2h”, of een datum en tijd zoals 2026-09-20T09:00.'
    }
  },
  relative: {
    now: 'nu',
    inSeconds: (value: number) => `over ${value}s`,
    inMinutes: (value: number) => `over ${value} min`,
    inHours: (value: number) => `over ${value}u`,
    inDays: (value: number) => `over ${value}d`,
    secondsAgo: (value: number) => `${value}s geleden`,
    minutesAgo: (value: number) => `${value} min geleden`,
    hoursAgo: (value: number) => `${value}u geleden`,
    daysAgo: (value: number) => `${value}d geleden`
  }
}
