/**
 * `features/mcp/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { mcpStrings } from '../../features/mcp/strings'
import type { Translation } from '../catalogue'

export const mcp: Translation<typeof mcpStrings> = {
  settings: {
    hint: 'Tools die je bots bereiken via het Model Context Protocol'
  },

  subtitle: 'Tools die je bots kunnen bereiken.',
  back: 'Instellingen',

  loading: 'De serverlijst lezen…',
  failed: (reason: string) => `Kon de servers niet lezen: ${reason}`,
  empty: 'Op deze gateway zijn geen MCP-servers ingesteld.',
  emptyHint: 'Voeg er een toe met `hermes mcp add`, of vanuit de Hermes-desktopapp.',

  runtime: {
    connected: 'Verbonden',
    connecting: 'Verbinden…',
    failed: 'Niet verbonden',
    disabled: 'Uitgeschakeld',
    lazy: 'Start wanneer nodig',
    configured: 'Ingesteld',
    unknown: 'Nog niet gestart'
  },

  detail: {
    title: 'MCP-server',
    address: 'Adres',
    auth: 'Authenticatie',
    authNone: 'Geen',
    env: 'OMGEVINGSSLEUTELS',
    envHint: 'De gateway stuurt hun waarden nooit mee — alleen welke sleutels deze server verwacht.',
    toolsUnknown: 'Test de verbinding om te zien wat deze server te bieden heeft.',
    toolsEmpty: 'Deze server bood geen tools aan.'
  },

  test: 'Verbinding testen',
  testing: 'Verbinden…',
  testOk: (count: number) => `Verbonden. ${count} ${count === 1 ? 'tool' : 'tools'} beschikbaar.`,
  testFailed: (reason: string) => `Kon niet verbinden: ${reason}`,

  needsAuth: 'Autorisatie nodig',
  authorise: 'Autoriseren…',
  authorising: 'Wachten op de browser…',
  authoriseHint: 'Opent je browser. Kom hier terug als je klaar bent met inloggen.',
  authoriseOk: 'Geautoriseerd.',
  authoriseFailed: (reason: string) => `Autorisatie niet afgerond: ${reason}`,

  reload: 'Servers herladen',
  reloadHint: 'Voert configuratiewijzigingen door in chats die al lopen.'
}
