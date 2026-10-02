/**
 * `features/bot-rename/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { renameStrings } from '../../features/bot-rename/strings'
import type { Translation } from '../catalogue'

export const botRename: Translation<typeof renameStrings> = {
  displayLabel: 'Weergavenaam',
  displayHint: 'Hoe deze bot in jouw lijst heet. De gateway houdt de eigen naam van het profiel.',
  clearHint: 'Laat het leeg om terug te vallen op de naam die de gateway doorgeeft.',
  displayAppOnly: 'Alleen in Hermie bewaard; de plug-in op de gateway is te oud om het daar op te slaan.',
  displayForbidden: 'Dit gateway-account mag profielnamen niet wijzigen.',

  profileLabel: 'Profielnaam',
  profileHint: 'De naam waarmee de rest van de app deze bot aanspreekt.',

  renameRow: 'Profiel hernoemen…',
  renameHint: 'Verandert het profiel op de gateway zelf, niet wat Hermie laat zien.',
  renameField: 'Nieuwe profielnaam',
  renameAction: 'Profiel hernoemen',
  renameBusy: 'Hernoemen…',
  renameCancel: 'Laat het zoals het is',
  profileWarning: 'Hernoemen verandert de profielnaam die andere tools gebruiken',
  renameDefault: 'Het standaardprofiel houdt zijn naam. Zijn thuis is de eigen map van de gateway.',

  placeholder: 'Niet ingesteld',

  refused: 'De gateway accepteerde die naam niet.',
  missing: (name: string) => `De gateway heeft geen profiel dat ${name} heet.`,
  failed: 'Die naam kon niet worden opgeslagen.',
  clearRefused: 'Het standaardprofiel heeft een naam nodig.',
  // `parts` staat achteraan, achter een dubbele punt: een werkwoord ervoor zou
  // moeten kiezen tussen enkelvoud en meervoud, en dat hangt van de lijst af.
  partial: (parts: string[]) =>
    `De gateway heeft deze bot hernoemd, maar dit kon niet mee: ${parts.join(' en ')}. Verbind opnieuw om het op te halen.`,
  partialStores: 'de open chats',
  partialCache: 'het bewaarde transcript'
}
