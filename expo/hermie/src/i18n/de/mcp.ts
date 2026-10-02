/**
 * `features/mcp/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { mcpStrings } from '../../features/mcp/strings'
import type { Translation } from '../catalogue'

export const mcp: Translation<typeof mcpStrings> = {
  settings: {
    hint: 'Tools, die deine Bots über das Model Context Protocol erreichen'
  },

  subtitle: 'Tools, die deine Bots erreichen können.',
  back: 'Einstellungen',

  loading: 'Serverliste wird gelesen…',
  failed: (reason: string) => `Die Server konnten nicht gelesen werden: ${reason}`,
  empty: 'Auf diesem Gateway sind keine MCP-Server konfiguriert.',
  emptyHint: 'Füge einen mit `hermes mcp add` hinzu oder in der Hermes-Desktop-App.',

  runtime: {
    connected: 'Verbunden',
    connecting: 'Verbindet…',
    failed: 'Nicht verbunden',
    disabled: 'Abgeschaltet',
    lazy: 'Startet bei Bedarf',
    configured: 'Konfiguriert',
    unknown: 'Noch nicht gestartet'
  },

  toolCount: (count: number) => `${count} ${count === 1 ? 'Tool' : 'Tools'}`,

  detail: {
    title: 'MCP-Server',
    address: 'Adresse',
    auth: 'Authentifizierung',
    authNone: 'Keine',
    // „UMGEBUNGSSCHLÜSSEL“ overflows the English header; `env` is the word the
    // gateway's own configuration uses for these.
    env: 'ENV-SCHLÜSSEL',
    envHint: 'Das Gateway sendet nie die Werte — nur, welche Schlüssel dieser Server erwartet.',
    toolsUnknown: 'Teste die Verbindung, um zu sehen, was dieser Server anbietet.',
    toolsEmpty: 'Dieser Server hat keine Tools angeboten.'
  },

  test: 'Verbindung testen',
  testing: 'Verbindet…',
  testOk: (count: number) => `Verbunden. ${count} ${count === 1 ? 'Tool' : 'Tools'} verfügbar.`,
  testFailed: (reason: string) => `Verbinden fehlgeschlagen: ${reason}`,

  needsAuth: 'Autorisierung nötig',
  authorise: 'Autorisieren…',
  authorising: 'Warten auf den Browser…',
  authoriseHint: 'Öffnet deinen Browser. Komm hierher zurück, wenn du dich angemeldet hast.',
  authoriseOk: 'Autorisiert.',
  authoriseFailed: (reason: string) => `Autorisierung nicht abgeschlossen: ${reason}`,

  // „Server neu laden“ overflows the button; the screen lists the servers.
  reload: 'Neu laden',
  reloadHint: 'Wendet Konfigurationsänderungen auf bereits laufende Chats an.'
}
