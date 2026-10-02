/**
 * `features/skills/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { skillStrings } from '../../features/skills/strings'
import type { Translation } from '../catalogue'

export const skills: Translation<typeof skillStrings> = {
  settings: {
    hint: 'Wat je bots kunnen'
  },

  subtitle: 'Instructies die je bots kunnen openen.',
  back: 'Instellingen',

  installed: 'GEÏNSTALLEERD',
  installedEmpty: 'Nog geen skills geïnstalleerd.',
  installedFooter: 'Een skill is een map met instructies die een bot opent wanneer hij ze nodig heeft.',
  loading: 'De skills lezen…',
  failed: (reason: string) => `Kon de skills niet lezen: ${reason}`,

  forBot: (name: string) => `De schakelaars zijn voor ${name}.`,
  noBot: 'Kies een bot om skills voor aan en uit te zetten.',

  catalogue: 'CATALOGUS',
  search: 'Zoek in de hub',
  searching: 'Zoeken…',
  catalogueEmpty: 'Niets gevonden.',
  alreadyInstalled: 'Geïnstalleerd',
  install: 'Installeren',
  installing: 'Installeren…',
  installed_: (name: string) => `${name} geïnstalleerd.`,
  installFailed: (reason: string) => `Installeren mislukt: ${reason}`,

  cliOnly: 'Deze gateway kan geen skills installeren via zijn socket. Voer dit uit op de machine die hem host:',

  toggleFailed: (reason: string) => `Kon dat niet wijzigen: ${reason}`
}
