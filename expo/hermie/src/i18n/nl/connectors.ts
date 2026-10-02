/**
 * `features/connectors/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { connectorStrings } from '../../features/connectors/strings'
import type { Translation } from '../catalogue'

export const connectors: Translation<typeof connectorStrings> = {
  settings: {
    hint: 'Apps die een bot namens jou kan bereiken'
  },

  subtitle: 'Apps waar je bots op inloggen.',
  back: 'Instellingen',

  loading: 'De connectors lezen…',
  failed: (reason: string) => `Kon de connectors niet lezen: ${reason}`,
  empty: 'Deze gateway biedt geen connectors.',

  unavailable: 'Connectors staan uit voor deze bot.',
  // "Connections" is de naam van de toolset zoals de gateway hem noemt;
  // "Mogelijkheden" is hoe het Capabilities-scherm hier heet.
  unavailableHint: 'Zet de toolset Connections aan bij Mogelijkheden van deze bot en kom dan terug.',

  scope: {
    hint: 'Connectors horen bij een chat. Deze pagina leest die van de chat die je kiest.',
    none: 'Er is geen chat open.',
    noneHint: 'Open eerst een chat — een connectorlijst bestaat alleen voor een lopend gesprek.'
  },

  state: {
    connected: 'Verbonden',
    notConnected: 'Niet verbonden',
    disabled: 'Uitgeschakeld',
    unknown: 'Onbekend'
  },

  reason: (text: string) => `Reden: ${text}`,

  connect: 'Verbinden…',
  reconnect: 'Opnieuw verbinden…',
  connecting: 'Wachten op de browser…',
  connectHint: 'Opent je browser. Kom hier terug als je klaar bent met inloggen.',
  connectOk: (name: string) => `${name} is verbonden.`,
  connectFailed: (reason: string) => `Verbinden mislukt: ${reason}`,
  connectNoUrl: 'De gateway opende een autorisatie, maar zei niet waar je heen moest.',
  connectExpired: 'De autorisatie verliep voordat hij af was.',
  connectSkipped: 'De autorisatie is niet afgerond.',

  refresh: 'Vernieuwen',

  disconnect: 'Uitloggen bij een connector doe je waar je het account beheert, niet vanuit Hermes.',

  detail: {
    title: 'Connector',
    enabled: 'Ingeschakeld',
    yes: 'Ja',
    no: 'Nee'
  }
}
