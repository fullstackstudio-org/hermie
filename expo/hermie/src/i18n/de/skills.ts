/**
 * `features/skills/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { skillStrings } from '../../features/skills/strings'
import type { Translation } from '../catalogue'

export const skills: Translation<typeof skillStrings> = {
  settings: {
    hint: 'Was deine Bots können'
  },

  subtitle: 'Anweisungen, die deine Bots öffnen können.',
  back: 'Einstellungen',

  installed: 'INSTALLIERT',
  installedEmpty: 'Noch keine Skills installiert.',
  installedFooter: 'Ein Skill ist ein Ordner mit Anweisungen, den ein Bot öffnet, wenn er sie braucht.',
  loading: 'Skills werden gelesen…',
  failed: (reason: string) => `Die Skills konnten nicht gelesen werden: ${reason}`,

  forBot: (name: string) => `Die Schalter gelten für ${name}.`,
  noBot: 'Wähl einen Bot, um Skills für ihn ein- und auszuschalten.',

  // „KATALOG“ is the German word and shorter than the English header.
  catalogue: 'KATALOG',
  search: 'Im Hub suchen',
  searching: 'Sucht…',
  catalogueEmpty: 'Nichts gefunden.',
  alreadyInstalled: 'Installiert',
  install: 'Installieren',
  installing: 'Wird installiert…',
  installed_: (name: string) => `${name} installiert.`,
  installFailed: (reason: string) => `Installation fehlgeschlagen: ${reason}`,

  cliOnly:
    'Dieses Gateway kann Skills nicht über seinen Socket installieren. Führ das auf der Maschine aus, die es hostet:',

  toggleFailed: (reason: string) => `Das ließ sich nicht ändern: ${reason}`
}
