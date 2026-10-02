/**
 * `features/memory/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 *
 * Een `entry` heet hier een **notitie**: het is wat de bot heeft opgeschreven,
 * en "invoer" zou het met een invoerveld verwarren.
 */
import type { memoryStrings } from '../../features/memory/strings'
import type { Translation } from '../catalogue'

export const memory: Translation<typeof memoryStrings> = {
  title: 'Geheugen',
  rowTitle: 'Geheugen',
  rowHint: 'Wat deze bot onthoudt over zijn werk, en over jou.',
  botsTitle: 'Geheugen',
  botsHint: 'Lees en bewerk wat elke bot onthoudt.',
  botsEmpty: 'Nog geen bots.',
  forBot: (name: string) => `Geheugen van ${name}`,

  tabs: {
    entries: 'Notities',
    // De afbeelding heet in de app een kaart ("Een kaart van dit geheugen"),
    // en "Graaf" leest als wiskunde.
    graph: 'Kaart',
    raw: 'Ruw'
  },

  // Deze twee koppen worden ook ingevuld in `usageLabel` en `add.label`
  // ("Toevoegen aan GEBRUIKER"), dus het moeten zelfstandige naamwoorden zijn.
  sections: {
    memory: 'GEHEUGEN',
    user: 'GEBRUIKER'
  },
  sectionHint: {
    memory: 'Wat de bot over zijn werk heeft opgeschreven. De MEMORY.md van Hermes zelf.',
    user: 'Wat de bot over jou heeft opgeschreven. USER.md.'
  },

  loading: 'Geheugen lezen…',
  empty: {
    memory: 'Nog niets opgeschreven.',
    user: 'Nog niets over jou opgeschreven.'
  },
  failed: (reason: string) => `Kon dit geheugen niet lezen: ${reason}`,
  retry: 'Opnieuw proberen',

  usage: (chars: number, limit: number) => `${chars} van ${limit} tekens`,
  usageUnbounded: (chars: number) => `${chars} tekens`,
  usageLabel: (target: string, percent: number) => `${target} is ${percent}% vol`,

  search: {
    placeholder: 'Zoek in dit geheugen',
    clear: 'Wissen',
    searching: 'Zoeken…',
    none: (query: string) => `Niets komt overeen met “${query}”.`,
    count: (found: number) => (found === 1 ? '1 notitie' : `${found} notities`),
    hint: 'Elk woord moet ergens in de notitie voorkomen. De volgorde maakt niet uit.'
  },

  add: {
    placeholder: 'Schrijf iets op',
    action: 'Toevoegen',
    label: (target: string) => `Toevoegen aan ${target}`
  },

  edit: {
    action: 'Bewerken',
    save: 'Vervangen',
    cancel: 'Annuleren',
    label: (index: number) => `Notitie ${index + 1} bewerken`
  },

  remove: {
    action: 'Verwijderen',
    label: (index: number) => `Notitie ${index + 1} verwijderen`,
    confirmTitle: 'Deze notitie verwijderen?',
    confirmBody: 'De bot krijgt dit niet meer te horen. Hermes bewaart geen geschiedenis van een geheugenbestand.',
    confirm: 'Verwijderen',
    cancel: 'Behouden'
  },

  readOnly:
    'Deze gateway laat geheugen lezen en niet schrijven. Zet memory.edit van de plugin aan voor dit profiel om dat te veranderen.',

  graph: {
    label: 'Een kaart van dit geheugen: de bot, zijn notities en de onderwerpen die ze delen',
    zoomIn: 'Inzoomen',
    zoomOut: 'Uitzoomen',
    empty: 'Nog niets om te tekenen.',
    loading: 'Tekenen…',
    truncated: (shown: number, total: number) =>
      `${shown} van ${total} notities te zien. De rest staat niet op deze pagina van de kaart.`,
    dropped: (count: number) => `Er zijn nog ${count} knooppunten weggelaten uit de tekening.`,
    full: {
      open: 'Schermvullend openen',
      title: 'Geheugenkaart',
      close: 'Sluiten',
      dismiss: 'De kaart sluiten'
    },
    detail: {
      profile: 'Deze bot',
      topic: 'Onderwerp',
      entry: 'Notitie',
      topics: 'NOEMT',
      noTopics: 'Geen onderwerpen in deze notitie.',
      open: 'Toon in de lijst',
      close: 'Sluiten'
    }
  },

  raw: {
    loading: 'Lezen wat elke backend bewaart…',
    readOnly: 'Alleen lezen. Notities pas je aan op het tabblad Notities.',
    emptyDocument: 'Deze is leeg.',
    truncated: 'De gateway stuurde alleen het begin hiervan.',
    chars: (chars: number) => `${chars} ${chars === 1 ? 'teken' : 'tekens'}`,
    unavailable: 'Deze backend is niet beschikbaar op deze gateway.',
    notListable: 'Deze backend kan niet zeggen wat hij bewaart.',
    none: 'Deze gateway noemde geen enkele geheugenbackend.',
    missing: 'De Hermie-plugin van deze gateway serveert geen ruw geheugen.',
    missingHint: 'Werk de plugin bij op de machine die de gateway draait:'
  },

  providers: {
    notBrowsable: 'Niet in te zien',
    hint: 'Een externe geheugenprovider geeft een bot tekst voor één beurt. Er is geen aanroep die opsomt wat hij bewaart, dus valt hier niets te tonen.'
  },

  missing: {
    title: 'De Hermie-plugin heeft geen geheugenbrowser',
    body: 'Het geheugen van een bot lezen vraagt om de hermie-plugin, versie 0.5.0 of nieuwer, geïnstalleerd op de gateway en ingeschakeld voor dit profiel.',
    install: 'OP DE GATEWAY',
    guide: 'Lees de handleiding',
    unknown: 'Wachten tot de gateway zegt wat er geïnstalleerd is…'
  }
}
