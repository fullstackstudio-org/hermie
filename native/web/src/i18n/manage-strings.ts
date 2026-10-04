/**
 * Strings only the web client has, that only the gateway-management pages say (Settings › Memory, Skills, MCP
 * servers, Connectors and Boards) and the bot profile's personality and model.
 *
 * The same table as `web-strings.ts`, under the same rules (one leaf, three languages; `web-strings.test.ts`
 * reads it), kept apart so that none of it is in the first load. **Only a module that is itself loaded on demand
 * may import this file.** What the Apple apps and the web client both say about these pages (every row, hint and
 * state of them) is the catalogue's (`strings.memory`, `strings.skills`, `strings.mcp`, `strings.connectors`,
 * `strings.kanban`); this table holds what a browser adds: the words of a control the apps do not have (a
 * disclosure, a form that adds a server), and the lines a page says after an action.
 */
import { type Branch, localise, type Translated } from './web-strings'

/** The strings, as written: every leaf in en, nl and de. */
export const MANAGE_STRINGS_SOURCE = {
  /** Said by more than one of the pages. */
  manageCommon: {
    saved: {
      en: 'Saved.',
      nl: 'Opgeslagen.',
      de: 'Gespeichert.'
    },
    /** Under a page whose gateway call is not there: the page cannot reach the gateway at all. */
    noGateway: {
      en: 'This page has no connection to the gateway.',
      nl: 'Deze pagina heeft geen verbinding met de gateway.',
      de: 'Diese Seite hat keine Verbindung zum Gateway.'
    },
    /** The gateway answered 403: this account may read it and not change it, or the feature is off. */
    refused: {
      en: 'The gateway refused that.',
      nl: 'De gateway weigerde dat.',
      de: 'Das Gateway hat das abgelehnt.'
    }
  },
  memoryPage: {
    /** The plugin's route answered 403: browsing is switched off for this profile. */
    switchedOff: {
      en: 'Memory browsing is switched off for this bot. Set plugins.entries.hermie.settings.memory.browse to true in its config.yaml and restart the gateway.',
      nl: 'Geheugen bekijken staat uit voor deze bot. Zet plugins.entries.hermie.settings.memory.browse op true in de config.yaml en herstart de gateway.',
      de: 'Das Durchsuchen des Gedächtnisses ist für diesen Bot ausgeschaltet. Setze plugins.entries.hermie.settings.memory.browse in seiner config.yaml auf true und starte das Gateway neu.'
    },
    /** The names of an entry's controls: its place in its file, so that two files' first entries are told apart. */
    entryText: {
      en: ({ index, file }: { index: number; file: string }) => `Text of entry ${index} in ${file}`,
      nl: ({ index, file }: { index: number; file: string }) => `Tekst van onderdeel ${index} in ${file}`,
      de: ({ index, file }: { index: number; file: string }) => `Text von Eintrag ${index} in ${file}`
    },
    editEntry: {
      en: ({ index, file }: { index: number; file: string }) => `Edit entry ${index} in ${file}`,
      nl: ({ index, file }: { index: number; file: string }) => `Onderdeel ${index} in ${file} bewerken`,
      de: ({ index, file }: { index: number; file: string }) => `Eintrag ${index} in ${file} bearbeiten`
    },
    removeEntry: {
      en: ({ index, file }: { index: number; file: string }) => `Remove entry ${index} from ${file}`,
      nl: ({ index, file }: { index: number; file: string }) => `Onderdeel ${index} uit ${file} verwijderen`,
      de: ({ index, file }: { index: number; file: string }) => `Eintrag ${index} aus ${file} entfernen`
    },
    /** Under an entry: how much of the file it takes. */
    entryChars: {
      en: ({ count }: { count: number }) => (count === 1 ? '1 character' : `${count} characters`),
      nl: ({ count }: { count: number }) => (count === 1 ? '1 teken' : `${count} tekens`),
      de: ({ count }: { count: number }) => (count === 1 ? '1 Zeichen' : `${count} Zeichen`)
    },
    /** After an add, a replace or a remove landed. */
    added: {
      en: 'Added.',
      nl: 'Toegevoegd.',
      de: 'Hinzugefügt.'
    },
    replaced: {
      en: 'Replaced.',
      nl: 'Vervangen.',
      de: 'Ersetzt.'
    },
    removed: {
      en: 'Removed.',
      nl: 'Verwijderd.',
      de: 'Entfernt.'
    }
  },
  skillsPage: {
    /** The gateway files an installed skill under a category; these are the two it uses. */
    bundled: {
      en: 'Bundled',
      nl: 'Meegeleverd',
      de: 'Mitgeliefert'
    },
    added: {
      en: 'Added',
      nl: 'Toegevoegd',
      de: 'Hinzugefügt'
    },
    /** The names of the controls on one hub row, so that several rows are told apart. */
    detailsOf: {
      en: ({ name }: { name: string }) => `Details of ${name}`,
      nl: ({ name }: { name: string }) => `Details van ${name}`,
      de: ({ name }: { name: string }) => `Details zu ${name}`
    },
    hideDetailsOf: {
      en: ({ name }: { name: string }) => `Hide the details of ${name}`,
      nl: ({ name }: { name: string }) => `De details van ${name} verbergen`,
      de: ({ name }: { name: string }) => `Die Details zu ${name} ausblenden`
    },
    installName: {
      en: ({ name }: { name: string }) => `Install ${name}`,
      nl: ({ name }: { name: string }) => `${name} installeren`,
      de: ({ name }: { name: string }) => `${name} installieren`
    },
    details: {
      en: 'Details',
      nl: 'Details',
      de: 'Details'
    },
    hideDetails: {
      en: 'Hide details',
      nl: 'Details verbergen',
      de: 'Details ausblenden'
    },
    loadingDetails: {
      en: 'Reading the details…',
      nl: 'De details worden gelezen…',
      de: 'Die Details werden gelesen…'
    },
    noDetails: {
      en: 'The hub has no details for this skill.',
      nl: 'De hub heeft geen details over deze skill.',
      de: 'Der Hub hat keine Details zu diesem Skill.'
    },
    detailsFailed: {
      en: ({ message }: { message: string }) => `Could not read the details: ${message}`,
      nl: ({ message }: { message: string }) => `De details konden niet worden gelezen: ${message}`,
      de: ({ message }: { message: string }) => `Die Details konnten nicht gelesen werden: ${message}`
    },
    /** Under a hub row: where the skill comes from. */
    source: {
      en: ({ source }: { source: string }) => `Source: ${source}`,
      nl: ({ source }: { source: string }) => `Bron: ${source}`,
      de: ({ source }: { source: string }) => `Quelle: ${source}`
    },
    trust: {
      en: ({ trust }: { trust: string }) => `Trust: ${trust}`,
      nl: ({ trust }: { trust: string }) => `Vertrouwen: ${trust}`,
      de: ({ trust }: { trust: string }) => `Vertrauen: ${trust}`
    },
    tags: {
      en: ({ tags }: { tags: string }) => `Tags: ${tags}`,
      nl: ({ tags }: { tags: string }) => `Labels: ${tags}`,
      de: ({ tags }: { tags: string }) => `Schlagwörter: ${tags}`
    },
    /** The label of the box that holds the skill's own instructions, which scrolls. */
    previewOf: {
      en: ({ name }: { name: string }) => `Instructions of ${name}`,
      nl: ({ name }: { name: string }) => `Instructies van ${name}`,
      de: ({ name }: { name: string }) => `Anleitung von ${name}`
    },
    showMore: {
      en: 'Show more',
      nl: 'Meer tonen',
      de: 'Mehr anzeigen'
    },
    /** What the page says it cannot do: the gateway has no action that removes a skill. */
    noUninstall: {
      en: 'Hermes has no way to remove a skill from here. Remove it on the machine that hosts the gateway.',
      nl: 'Hermes kan hier geen skill verwijderen. Verwijder hem op de machine waarop de gateway draait.',
      de: 'Hermes kann hier keinen Skill entfernen. Entferne ihn auf dem Rechner, auf dem das Gateway läuft.'
    },
    /** Under an installed skill's switch: the category the gateway filed it under. */
    switchHint: {
      en: ({ category }: { category: string }) => `Category: ${category}`,
      nl: ({ category }: { category: string }) => `Categorie: ${category}`,
      de: ({ category }: { category: string }) => `Kategorie: ${category}`
    }
  }
} as const satisfies Branch

export type ManageStrings = Translated<typeof MANAGE_STRINGS_SOURCE>

/** The management pages' web-only strings in the language the reader is using. */
export const manageStrings = localise(MANAGE_STRINGS_SOURCE) as unknown as ManageStrings
