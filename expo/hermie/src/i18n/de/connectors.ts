/**
 * `features/connectors/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { connectorStrings } from '../../features/connectors/strings'
import type { Translation } from '../catalogue'

export const connectors: Translation<typeof connectorStrings> = {
  settings: {
    hint: 'Apps, die ein Bot in deinem Namen erreichen kann'
  },

  subtitle: 'Apps, bei denen deine Bots angemeldet sind.',
  back: 'Einstellungen',

  loading: 'Connectors werden gelesen…',
  failed: (reason: string) => `Connectors konnten nicht gelesen werden: ${reason}`,
  empty: 'Dieses Gateway bietet keine Connectors an.',

  unavailable: 'Connectors sind für diesen Bot abgeschaltet.',
  unavailableHint: 'Schalte das Toolset „Connections“ in den Fähigkeiten des Bots ein und komm dann zurück.',

  scope: {
    hint: 'Connectors gehören zu einem Chat. Diese Seite liest den, den du auswählst.',
    none: 'Es ist kein Chat offen.',
    noneHint: 'Öffne zuerst einen Chat — eine Connector-Liste gibt es nur für eine laufende Unterhaltung.'
  },

  state: {
    connected: 'Verbunden',
    notConnected: 'Nicht verbunden',
    disabled: 'Abgeschaltet',
    unknown: 'Unbekannt'
  },

  reason: (text: string) => `Grund: ${text}`,

  connect: 'Verbinden…',
  reconnect: 'Neu verbinden…',
  connecting: 'Warten auf den Browser…',
  connectHint: 'Öffnet deinen Browser. Komm hierher zurück, wenn du dich angemeldet hast.',
  connectOk: (name: string) => `${name} ist verbunden.`,
  connectFailed: (reason: string) => `Verbinden fehlgeschlagen: ${reason}`,
  connectNoUrl: 'Das Gateway hat eine Autorisierung geöffnet, aber nicht gesagt, wohin du geschickt werden sollst.',
  connectExpired: 'Die Autorisierung ist abgelaufen, bevor sie fertig war.',
  connectSkipped: 'Die Autorisierung wurde nicht abgeschlossen.',

  refresh: 'Aktualisieren',

  disconnect: 'Einen Connector meldest du dort ab, wo du das Konto verwaltest, nicht in Hermes.',

  detail: {
    title: 'Connector',
    slug: 'Kennung',
    enabled: 'Aktiviert',
    yes: 'Ja',
    no: 'Nein'
  }
}
