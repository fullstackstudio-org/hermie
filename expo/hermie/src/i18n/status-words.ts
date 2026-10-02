/**
 * The gateway's status enums, in the languages Hermie speaks.
 *
 * Beside `humanise.ts` rather than inside it, for the reason every translation
 * in this round sits in a file of its own: the English table is the source and
 * a translation is a layer over it, and keeping the two apart is what lets a
 * new status be added in English today and translated whenever somebody gets
 * to it.
 *
 * The keys are the RAW gateway values, lower-cased, exactly as `humanise.ts`
 * looks them up. They are not a Hermie vocabulary and must not be tidied: `ok`
 * and `success` are two things the gateway says for one state, and both have to
 * be here or one of them falls through to the generic capitalisation.
 */
import { activeLocale } from './active-locale'
import type { Locale } from './locales'

const WORDS: Partial<Record<Locale, Record<string, string>>> = {
  nl: {
    active: 'Actief',
    cancelled: 'Geannuleerd',
    canceled: 'Geannuleerd',
    complete: 'Klaar',
    completed: 'Klaar',
    done: 'Klaar',
    error: 'Mislukt',
    failed: 'Mislukt',
    failure: 'Mislukt',
    ok: 'Gelukt',
    paused: 'Gepauzeerd',
    pending: 'Wacht',
    queued: 'Wacht',
    running: 'Bezig',
    skipped: 'Overgeslagen',
    success: 'Gelukt',
    timeout: 'Time-out',
    timed_out: 'Time-out',
    waiting: 'Wacht'
  },
  de: {
    active: 'Aktiv',
    cancelled: 'Abgebrochen',
    canceled: 'Abgebrochen',
    complete: 'Fertig',
    completed: 'Fertig',
    done: 'Fertig',
    error: 'Fehlgeschlagen',
    failed: 'Fehlgeschlagen',
    failure: 'Fehlgeschlagen',
    ok: 'Erfolgreich',
    paused: 'Pausiert',
    pending: 'Wartet',
    queued: 'Wartet',
    running: 'Läuft',
    skipped: 'Übersprungen',
    success: 'Erfolgreich',
    timeout: 'Zeitüberschreitung',
    timed_out: 'Zeitüberschreitung',
    waiting: 'Wartet'
  }
}

/**
 * The active language's word for a raw status, or nothing.
 *
 * Nothing rather than the English word: the caller already has the English
 * table and is better placed to fall back to it, and a helper that answered
 * "Success" would make a missing Dutch entry indistinguishable from a status
 * Dutch deliberately leaves in English.
 */
export function translatedStatus(raw: string): string | undefined {
  return WORDS[activeLocale()]?.[raw]
}

/** Which raw statuses a locale answers for, so a test can compare the sets. */
export function statusWordsFor(locale: Locale): Record<string, string> {
  return WORDS[locale] ?? {}
}
