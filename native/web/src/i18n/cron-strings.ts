/**
 * Strings only the web client has, that only the Crons and Activity pages say.
 *
 * The same table as `web-strings.ts`, under the same rules (one leaf, three languages; `web-strings.test.ts`
 * reads it), kept apart so that none of it is in the first load. **Only a module that is itself loaded on
 * demand may import this file**: one import from the entry's graph puts all of it back there. What both
 * clients say (the list, the detail page, the editor, the run page, the Activity timeline) is the catalogue's
 * (`strings.cron`, `strings.app.activity`); this table holds what a browser adds: how a schedule reads in words,
 * what the page says after an action, and the names of controls that have no label in the apps.
 */
import { type Branch, localise, type Translated } from './web-strings'

/** The strings, as written: every leaf in en, nl and de. */
export const CRON_STRINGS_SOURCE = {
  /** A schedule, in words. Built from what the gateway's schedule parser accepts (`cron/jobs.py::parse_schedule`). */
  schedule: {
    everyMinutes: {
      en: ({ count }: { count: number }) => (count === 1 ? 'Every minute' : `Every ${count} minutes`),
      nl: ({ count }: { count: number }) => (count === 1 ? 'Elke minuut' : `Elke ${count} minuten`),
      de: ({ count }: { count: number }) => (count === 1 ? 'Jede Minute' : `Alle ${count} Minuten`)
    },
    everyHours: {
      en: ({ count }: { count: number }) => (count === 1 ? 'Every hour' : `Every ${count} hours`),
      nl: ({ count }: { count: number }) => (count === 1 ? 'Elk uur' : `Elke ${count} uur`),
      de: ({ count }: { count: number }) => (count === 1 ? 'Jede Stunde' : `Alle ${count} Stunden`)
    },
    everyDays: {
      en: ({ count }: { count: number }) => (count === 1 ? 'Every day' : `Every ${count} days`),
      nl: ({ count }: { count: number }) => (count === 1 ? 'Elke dag' : `Elke ${count} dagen`),
      de: ({ count }: { count: number }) => (count === 1 ? 'Jeden Tag' : `Alle ${count} Tage`)
    },
    everyDayAt: {
      en: ({ time }: { time: string }) => `Every day at ${time}`,
      nl: ({ time }: { time: string }) => `Elke dag om ${time}`,
      de: ({ time }: { time: string }) => `Jeden Tag um ${time}`
    },
    weekdaysAt: {
      en: ({ time }: { time: string }) => `On weekdays at ${time}`,
      nl: ({ time }: { time: string }) => `Op werkdagen om ${time}`,
      de: ({ time }: { time: string }) => `Werktags um ${time}`
    },
    weekendsAt: {
      en: ({ time }: { time: string }) => `On weekends at ${time}`,
      nl: ({ time }: { time: string }) => `In het weekend om ${time}`,
      de: ({ time }: { time: string }) => `Am Wochenende um ${time}`
    },
    /** `days` is the weekdays as a list in the reader's language: "Monday and Friday". */
    daysAt: {
      en: ({ days, time }: { days: string; time: string }) => `Every ${days} at ${time}`,
      nl: ({ days, time }: { days: string; time: string }) => `Elke ${days} om ${time}`,
      de: ({ days, time }: { days: string; time: string }) => `Jeden ${days} um ${time}`
    },
    monthlyAt: {
      en: ({ day, time }: { day: string; time: string }) => `Monthly, on day ${day} at ${time}`,
      nl: ({ day, time }: { day: string; time: string }) => `Maandelijks, op dag ${day} om ${time}`,
      de: ({ day, time }: { day: string; time: string }) => `Monatlich, am ${day}. um ${time}`
    },
    onceInMinutes: {
      en: ({ count }: { count: number }) => (count === 1 ? 'Once, in 1 minute' : `Once, in ${count} minutes`),
      nl: ({ count }: { count: number }) =>
        count === 1 ? 'Eenmalig, over 1 minuut' : `Eenmalig, over ${count} minuten`,
      de: ({ count }: { count: number }) => (count === 1 ? 'Einmalig, in 1 Minute' : `Einmalig, in ${count} Minuten`)
    },
    onceInHours: {
      en: ({ count }: { count: number }) => (count === 1 ? 'Once, in 1 hour' : `Once, in ${count} hours`),
      nl: ({ count }: { count: number }) => `Eenmalig, over ${count} uur`,
      de: ({ count }: { count: number }) => (count === 1 ? 'Einmalig, in 1 Stunde' : `Einmalig, in ${count} Stunden`)
    },
    onceInDays: {
      en: ({ count }: { count: number }) => (count === 1 ? 'Once, in 1 day' : `Once, in ${count} days`),
      nl: ({ count }: { count: number }) => (count === 1 ? 'Eenmalig, over 1 dag' : `Eenmalig, over ${count} dagen`),
      de: ({ count }: { count: number }) => (count === 1 ? 'Einmalig, in 1 Tag' : `Einmalig, in ${count} Tagen`)
    },
    /** `when` is the date and time as the gateway wrote it: its zone is the gateway's, so it is not converted. */
    onceAt: {
      en: ({ when }: { when: string }) => `Once, at ${when}`,
      nl: ({ when }: { when: string }) => `Eenmalig, op ${when}`,
      de: ({ when }: { when: string }) => `Einmalig, am ${when}`
    }
  },
  /** What the page says after something was done, or refused. Polite status lines. */
  outcome: {
    started: {
      en: ({ name }: { name: string }) => `${name} is running now.`,
      nl: ({ name }: { name: string }) => `${name} wordt nu uitgevoerd.`,
      de: ({ name }: { name: string }) => `${name} läuft jetzt.`
    },
    paused: {
      en: ({ name }: { name: string }) => `${name} is paused.`,
      nl: ({ name }: { name: string }) => `${name} is gepauzeerd.`,
      de: ({ name }: { name: string }) => `${name} ist pausiert.`
    },
    resumed: {
      en: ({ name }: { name: string }) => `${name} is active again.`,
      nl: ({ name }: { name: string }) => `${name} is weer actief.`,
      de: ({ name }: { name: string }) => `${name} ist wieder aktiv.`
    },
    deleted: {
      en: ({ name }: { name: string }) => `${name} was deleted.`,
      nl: ({ name }: { name: string }) => `${name} is verwijderd.`,
      de: ({ name }: { name: string }) => `${name} wurde gelöscht.`
    },
    saved: {
      en: ({ name }: { name: string }) => `${name} was saved.`,
      nl: ({ name }: { name: string }) => `${name} is opgeslagen.`,
      de: ({ name }: { name: string }) => `${name} wurde gespeichert.`
    },
    created: {
      en: ({ name }: { name: string }) => `${name} was created.`,
      nl: ({ name }: { name: string }) => `${name} is aangemaakt.`,
      de: ({ name }: { name: string }) => `${name} wurde angelegt.`
    },
    failed: {
      en: ({ message }: { message: string }) => `That did not work: ${message}`,
      nl: ({ message }: { message: string }) => `Dat is niet gelukt: ${message}`,
      de: ({ message }: { message: string }) => `Das hat nicht geklappt: ${message}`
    }
  },
  /** The Activity timeline: the status of one row, where the catalogue has no word for it. */
  activity: {
    replied: {
      en: 'Replied',
      nl: 'Beantwoord',
      de: 'Beantwortet'
    },
    queued: {
      en: 'Queued',
      nl: 'In de wachtrij',
      de: 'In der Warteschlange'
    },
    sending: {
      en: 'Sending',
      nl: 'Wordt verzonden',
      de: 'Wird gesendet'
    },
    sent: {
      en: 'Sent',
      nl: 'Verzonden',
      de: 'Gesendet'
    }
  },
  /** The gateway has no cron with this id: a stale link, or one deleted elsewhere. */
  notFound: {
    en: 'This cron does not exist (any more).',
    nl: 'Deze cron bestaat niet (meer).',
    de: 'Diese Cron gibt es nicht (mehr).'
  },
  /** A row's action button, named for the cron it acts on: `Pause: Morning briefing`. */
  actionFor: {
    en: ({ action, name }: { action: string; name: string }) => `${action}: ${name}`,
    nl: ({ action, name }: { action: string; name: string }) => `${action}: ${name}`,
    de: ({ action, name }: { action: string; name: string }) => `${action}: ${name}`
  },
  /** On a run in the history: opens the run's transcript. */
  viewRun: {
    en: 'View run',
    nl: 'Run bekijken',
    de: 'Lauf ansehen'
  },
  /** The run's own page, naming the run. */
  runHeading: {
    en: ({ name }: { name: string }) => `Run of ${name}`,
    nl: ({ name }: { name: string }) => `Run van ${name}`,
    de: ({ name }: { name: string }) => `Lauf von ${name}`
  },
  /** The label of the unit control beside the interval's number. */
  unit: {
    en: 'Unit',
    nl: 'Eenheid',
    de: 'Einheit'
  },
  /** The cron's actions, as a group. */
  actionsLabel: {
    en: ({ name }: { name: string }) => `Actions for ${name}`,
    nl: ({ name }: { name: string }) => `Acties voor ${name}`,
    de: ({ name }: { name: string }) => `Aktionen für ${name}`
  },
  /** Under a cron that delivers into a bot's chat: the way to that chat. */
  deliveredChat: {
    en: ({ name }: { name: string }) => `Open the chat with ${name}`,
    nl: ({ name }: { name: string }) => `Open de chat met ${name}`,
    de: ({ name }: { name: string }) => `Chat mit ${name} öffnen`
  }
} as const satisfies Branch

export type CronStrings = Translated<typeof CRON_STRINGS_SOURCE>

/** The Crons and Activity pages' web-only strings in the language the reader is using. */
export const cronWebStrings = localise(CRON_STRINGS_SOURCE) as unknown as CronStrings
