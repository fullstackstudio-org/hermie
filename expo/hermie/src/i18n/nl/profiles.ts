/**
 * `features/profiles/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { profileStrings } from '../../features/profiles/strings'
import type { Translation } from '../catalogue'

export const profiles: Translation<typeof profileStrings> = {
  settings: {
    newBot: 'Nieuwe bot…',
    newBotHint: 'Maak nog een bot op deze gateway'
  },

  new: {
    title: 'Nieuwe bot',
    eyebrow: 'Een bot van jezelf',
    handleHint:
      'Kleine letters, geen spaties. Dit is de naam waaronder de gateway hem kent, en die kan later niet veranderen.',
    displayName: 'Weergavenaam',
    displayNameHint: 'Wat Hermie in de lijst laat zien. Laat het leeg om de handle te gebruiken.',
    description: 'Beschrijving',
    descriptionPlaceholder: 'Zoekt dingen op voordat iemand erom vraagt.',
    modelInherit: 'Overnemen van de start-bot',
    modelHint: 'Een nieuwe bot neemt het model van de gateway over, tenzij je hier een model vastzet.',
    cloneFrom: 'Instellingen kopiëren van',
    cloneNone: 'Blanco beginnen',
    cloneHint:
      'Een kloon neemt de skills, tools en MCP-schakelaars van de bronbot over. Zijn berichtenaccounts gaan nooit mee — twee bots kunnen niet één Telegram-token vasthouden.',
    create: 'Bot maken',
    cancel: 'Annuleren',
    creating: 'De bot maken…',
    failed: (reason: string) => `Kon de bot niet maken: ${reason}`,
    withoutModel: 'Deze bot heeft nog geen model. Kies er een in zijn profiel voordat je hem schrijft.'
  },

  capabilities: {
    // "Capabilities" heeft geen ingeburgerd Nederlands equivalent in deze app;
    // "Mogelijkheden" dekt de lading en staat ook in de tekst bij Connectors.
    row: 'Mogelijkheden',
    rowDetail: 'Skills, tools en MCP-servers voor deze bot',
    title: 'Mogelijkheden',
    loading: 'De configuratie van deze bot lezen…',
    failed: (reason: string) => `Kon de configuratie niet lezen: ${reason}`,
    saveFailed: (reason: string) => `De gateway weigerde de wijziging: ${reason}`,
    toolsetsUnpinned: 'Deze bot volgt de standaard van de gateway. Eén schakelaar omzetten zet de hele lijst vast.',
    toolsetsPinned: 'Vastgezet voor deze bot.',
    skillsEmpty: 'Geen skills geïnstalleerd voor deze bot.',
    skillsFooter: 'Skills zijn mappen met instructies die de bot kan openen wanneer hij ze nodig heeft.',
    mcpEmpty: 'Geen MCP-servers ingesteld op deze gateway.',
    mcpFooter: 'Een server hier aanzetten maakt zijn tools beschikbaar voor deze bot.',
    manageMcp: 'Servers beheren…',

    reload: {
      title: 'Toepassen op lopende chats?',
      eyebrow: 'MCP herladen',
      body: 'MCP-servers herladen voor elke lopende chat. Het volgende bericht in elke chat stuurt zijn volledige invoer opnieuw.',
      now: 'Nu herladen',
      always: 'Herladen, en niet meer vragen',
      alwaysHint: 'Zorgt dat de gateway het niet meer vraagt — ook niet in de CLI en de desktopapp.',
      later: 'Nu niet',
      done: 'MCP-servers zijn herladen.',
      failed: (reason: string) => `Kon niet herladen: ${reason}`
    }
  }
}
