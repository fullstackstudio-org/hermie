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
  }
} as const satisfies Branch

export type ManageStrings = Translated<typeof MANAGE_STRINGS_SOURCE>

/** The management pages' web-only strings in the language the reader is using. */
export const manageStrings = localise(MANAGE_STRINGS_SOURCE) as unknown as ManageStrings
