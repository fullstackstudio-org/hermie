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
    /** Signing in to another service from a page: the address is a link the reader opens, because a page may not open a window from the middle of a call. */
    openSignIn: {
      en: 'Open the sign-in page',
      nl: 'De inlogpagina openen',
      de: 'Die Anmeldeseite öffnen'
    },
    signInWaiting: {
      en: ({ name }: { name: string }) => `Waiting for you to finish signing in to ${name}…`,
      nl: ({ name }: { name: string }) => `Wachten tot je klaar bent met inloggen bij ${name}…`,
      de: ({ name }: { name: string }) => `Warte darauf, dass du die Anmeldung bei ${name} abschließt…`
    },
    cancelSignIn: {
      en: 'Cancel',
      nl: 'Annuleren',
      de: 'Abbrechen'
    },
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
  mcpServersPage: {
    /** The names of one server's controls, so that several servers are told apart. */
    testName: {
      en: ({ name }: { name: string }) => `Test the connection to ${name}`,
      nl: ({ name }: { name: string }) => `De verbinding met ${name} testen`,
      de: ({ name }: { name: string }) => `Verbindung zu ${name} testen`
    },
    authoriseName: {
      en: ({ name }: { name: string }) => `Authorise ${name}`,
      nl: ({ name }: { name: string }) => `${name} autoriseren`,
      de: ({ name }: { name: string }) => `${name} autorisieren`
    },
    removeName: {
      en: ({ name }: { name: string }) => `Remove ${name}`,
      nl: ({ name }: { name: string }) => `${name} verwijderen`,
      de: ({ name }: { name: string }) => `${name} entfernen`
    },
    remove: {
      en: 'Remove',
      nl: 'Verwijderen',
      de: 'Entfernen'
    },
    removeQuestion: {
      en: ({ name }: { name: string }) => `Remove ${name}?`,
      nl: ({ name }: { name: string }) => `${name} verwijderen?`,
      de: ({ name }: { name: string }) => `${name} entfernen?`
    },
    removeDetail: {
      en: 'The server is taken out of this bot’s configuration. Chats that are already running keep it until the servers are reloaded.',
      nl: 'De server wordt uit de configuratie van deze bot gehaald. Chats die al lopen houden hem tot de servers opnieuw zijn geladen.',
      de: 'Der Server wird aus der Konfiguration dieses Bots entfernt. Laufende Chats behalten ihn, bis die Server neu geladen werden.'
    },
    keep: {
      en: 'Keep it',
      nl: 'Bewaren',
      de: 'Behalten'
    },
    removed: {
      en: ({ name }: { name: string }) => `${name} was removed.`,
      nl: ({ name }: { name: string }) => `${name} is verwijderd.`,
      de: ({ name }: { name: string }) => `${name} wurde entfernt.`
    },
    removeFailed: {
      en: ({ message }: { message: string }) => `Could not remove it: ${message}`,
      nl: ({ message }: { message: string }) => `Verwijderen lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Entfernen war nicht möglich: ${message}`
    },
    /** Under a server: where it connects, and what it is. */
    transportValue: {
      en: ({ transport }: { transport: string }) => `Transport: ${transport}`,
      nl: ({ transport }: { transport: string }) => `Transport: ${transport}`,
      de: ({ transport }: { transport: string }) => `Transport: ${transport}`
    },
    envKeys: {
      en: ({ keys }: { keys: string }) => `Needs: ${keys}`,
      nl: ({ keys }: { keys: string }) => `Heeft nodig: ${keys}`,
      de: ({ keys }: { keys: string }) => `Braucht: ${keys}`
    },
    authValue: {
      en: ({ auth }: { auth: string }) => `Authentication: ${auth}`,
      nl: ({ auth }: { auth: string }) => `Authenticatie: ${auth}`,
      de: ({ auth }: { auth: string }) => `Authentifizierung: ${auth}`
    },
    tokenPresent: {
      en: 'A token is stored.',
      nl: 'Er is een token opgeslagen.',
      de: 'Ein Token ist gespeichert.'
    },
    tokenMissing: {
      en: 'No token is stored yet.',
      nl: 'Er is nog geen token opgeslagen.',
      de: 'Es ist noch kein Token gespeichert.'
    },
    /** The probe's tools, as a list under the server. */
    toolsHeading: {
      en: ({ name }: { name: string }) => `Tools of ${name}`,
      nl: ({ name }: { name: string }) => `Tools van ${name}`,
      de: ({ name }: { name: string }) => `Tools von ${name}`
    },
    noTools: {
      en: 'This server offered no tools.',
      nl: 'Deze server bood geen tools aan.',
      de: 'Dieser Server hat keine Tools angeboten.'
    },
    signInCancelled: {
      en: 'The authorisation was cancelled.',
      nl: 'De autorisatie is geannuleerd.',
      de: 'Die Autorisierung wurde abgebrochen.'
    },
    /** Reloading the servers into chats that are already running: the gateway may want an answer first. */
    reloadDone: {
      en: 'The servers were reloaded.',
      nl: 'De servers zijn opnieuw geladen.',
      de: 'Die Server wurden neu geladen.'
    },
    reloadFailed: {
      en: ({ message }: { message: string }) => `Could not reload the servers: ${message}`,
      nl: ({ message }: { message: string }) => `De servers konden niet opnieuw worden geladen: ${message}`,
      de: ({ message }: { message: string }) => `Die Server konnten nicht neu geladen werden: ${message}`
    },
    reloadAnyway: {
      en: 'Reload anyway',
      nl: 'Toch opnieuw laden',
      de: 'Trotzdem neu laden'
    },
    reloadQuestion: {
      en: 'Reload the servers into running chats?',
      nl: 'De servers opnieuw laden in lopende chats?',
      de: 'Die Server in laufende Chats neu laden?'
    },
    /** The form that adds a server. */
    add: {
      en: 'Add a server',
      nl: 'Een server toevoegen',
      de: 'Einen Server hinzufügen'
    },
    addName: {
      en: 'Name',
      nl: 'Naam',
      de: 'Name'
    },
    addNameHint: {
      en: 'Letters, digits, dashes and underscores. Chats see the server’s tools under this name.',
      nl: 'Letters, cijfers, streepjes en underscores. Chats zien de tools van de server onder deze naam.',
      de: 'Buchstaben, Ziffern, Bindestriche und Unterstriche. Chats sehen die Tools des Servers unter diesem Namen.'
    },
    addSource: {
      en: 'Start from',
      nl: 'Beginnen met',
      de: 'Ausgehen von'
    },
    addCustom: {
      en: 'A server of my own',
      nl: 'Een eigen server',
      de: 'Ein eigener Server'
    },
    addUrl: {
      en: 'Address (for a server that is reached over HTTP)',
      nl: 'Adres (voor een server die via HTTP wordt bereikt)',
      de: 'Adresse (für einen Server, der über HTTP erreicht wird)'
    },
    addCommand: {
      en: 'Command (for a server that is started here)',
      nl: 'Opdracht (voor een server die hier wordt gestart)',
      de: 'Befehl (für einen Server, der hier gestartet wird)'
    },
    addArgs: {
      en: 'Arguments, separated by spaces',
      nl: 'Argumenten, gescheiden door spaties',
      de: 'Argumente, durch Leerzeichen getrennt'
    },
    addToken: {
      en: 'Access token (optional)',
      nl: 'Toegangstoken (optioneel)',
      de: 'Zugriffstoken (optional)'
    },
    addTokenHint: {
      en: 'Sent to the gateway once and kept in the bot’s .env there. Hermie does not keep it.',
      nl: 'Eén keer naar de gateway gestuurd en daar bewaard in de .env van de bot. Hermie bewaart het niet.',
      de: 'Wird einmal an das Gateway gesendet und dort in der .env des Bots gespeichert. Hermie speichert es nicht.'
    },
    addNeeds: {
      en: ({ keys }: { keys: string }) => `Needs ${keys} in the bot’s environment.`,
      nl: ({ keys }: { keys: string }) => `Heeft ${keys} nodig in de omgeving van de bot.`,
      de: ({ keys }: { keys: string }) => `Braucht ${keys} in der Umgebung des Bots.`
    },
    addSubmit: {
      en: 'Add the server',
      nl: 'De server toevoegen',
      de: 'Den Server hinzufügen'
    },
    adding: {
      en: 'Adding…',
      nl: 'Toevoegen…',
      de: 'Wird hinzugefügt…'
    },
    added: {
      en: ({ name }: { name: string }) => `${name} was added.`,
      nl: ({ name }: { name: string }) => `${name} is toegevoegd.`,
      de: ({ name }: { name: string }) => `${name} wurde hinzugefügt.`
    },
    addFailed: {
      en: ({ message }: { message: string }) => `Could not add it: ${message}`,
      nl: ({ message }: { message: string }) => `Toevoegen lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Hinzufügen war nicht möglich: ${message}`
    },
    needsNameAndSource: {
      en: 'Give the server a name and either an address or a command.',
      nl: 'Geef de server een naam en een adres of een opdracht.',
      de: 'Gib dem Server einen Namen und entweder eine Adresse oder einen Befehl an.'
    }
  },
  connectorsPage: {
    /** The names of one connector's controls, so that several connectors are told apart. */
    connectName: {
      en: ({ name }: { name: string }) => `Connect ${name}`,
      nl: ({ name }: { name: string }) => `${name} koppelen`,
      de: ({ name }: { name: string }) => `${name} verbinden`
    },
    reconnectName: {
      en: ({ name }: { name: string }) => `Reconnect ${name}`,
      nl: ({ name }: { name: string }) => `${name} opnieuw koppelen`,
      de: ({ name }: { name: string }) => `${name} erneut verbinden`
    },
    /** The vendor's own word for the state, under the connector's name. */
    vendorStatus: {
      en: ({ status }: { status: string }) => `Status: ${status}`,
      nl: ({ status }: { status: string }) => `Status: ${status}`,
      de: ({ status }: { status: string }) => `Status: ${status}`
    }
  },
  boardsPage: {
    /** The label of the board picker. */
    board: {
      en: 'Board',
      nl: 'Bord',
      de: 'Board'
    },
    /** A column's heading: its name and how many cards are in it. */
    columnHeading: {
      en: ({ name, count }: { name: string; count: number }) => `${name} (${count})`,
      nl: ({ name, count }: { name: string; count: number }) => `${name} (${count})`,
      de: ({ name, count }: { name: string; count: number }) => `${name} (${count})`
    },
    /** The names of one card's controls, so that several cards are told apart. */
    openCard: {
      en: ({ title }: { title: string }) => `Open ${title}`,
      nl: ({ title }: { title: string }) => `${title} openen`,
      de: ({ title }: { title: string }) => `${title} öffnen`
    },
    closeCard: {
      en: ({ title }: { title: string }) => `Close ${title}`,
      nl: ({ title }: { title: string }) => `${title} sluiten`,
      de: ({ title }: { title: string }) => `${title} schließen`
    },
    open: {
      en: 'Open',
      nl: 'Openen',
      de: 'Öffnen'
    },
    close: {
      en: 'Close',
      nl: 'Sluiten',
      de: 'Schließen'
    },
    moveCard: {
      en: ({ title }: { title: string }) => `Move ${title} to…`,
      nl: ({ title }: { title: string }) => `${title} verplaatsen naar…`,
      de: ({ title }: { title: string }) => `${title} verschieben nach…`
    },
    archiveName: {
      en: ({ title }: { title: string }) => `Archive ${title}`,
      nl: ({ title }: { title: string }) => `${title} archiveren`,
      de: ({ title }: { title: string }) => `${title} archivieren`
    },
    archiveQuestion: {
      en: ({ title }: { title: string }) => `Archive ${title}?`,
      nl: ({ title }: { title: string }) => `${title} archiveren?`,
      de: ({ title }: { title: string }) => `${title} archivieren?`
    },
    archiveFailed: {
      en: ({ message }: { message: string }) => `Could not archive it: ${message}`,
      nl: ({ message }: { message: string }) => `Archiveren lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Archivieren war nicht möglich: ${message}`
    },
    saveFailed: {
      en: ({ message }: { message: string }) => `Could not save: ${message}`,
      nl: ({ message }: { message: string }) => `Opslaan lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Speichern war nicht möglich: ${message}`
    },
    createFailed: {
      en: ({ message }: { message: string }) => `Could not make the card: ${message}`,
      nl: ({ message }: { message: string }) => `De kaart maken lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Die Karte konnte nicht erstellt werden: ${message}`
    },
    created: {
      en: ({ title }: { title: string }) => `${title} was made.`,
      nl: ({ title }: { title: string }) => `${title} is gemaakt.`,
      de: ({ title }: { title: string }) => `${title} wurde erstellt.`
    },
    commentFailed: {
      en: ({ message }: { message: string }) => `Could not post the comment: ${message}`,
      nl: ({ message }: { message: string }) => `De reactie plaatsen lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Der Kommentar konnte nicht gesendet werden: ${message}`
    },
    /** A comment's author and when it was written. */
    commentBy: {
      en: ({ author, date }: { author: string; date: string }) => `${author}, ${date}`,
      nl: ({ author, date }: { author: string; date: string }) => `${author}, ${date}`,
      de: ({ author, date }: { author: string; date: string }) => `${author}, ${date}`
    },
    commentLabel: {
      en: ({ title }: { title: string }) => `Comment on ${title}`,
      nl: ({ title }: { title: string }) => `Reageer op ${title}`,
      de: ({ title }: { title: string }) => `Kommentar zu ${title}`
    },
    priorityHint: {
      en: 'Higher comes first in its column.',
      nl: 'Hoger komt eerst in zijn kolom.',
      de: 'Höher steht in seiner Spalte weiter oben.'
    },
    priorityInvalid: {
      en: 'Priority is a whole number.',
      nl: 'Prioriteit is een geheel getal.',
      de: 'Die Priorität ist eine ganze Zahl.'
    },
    noAssignee: {
      en: 'Nobody',
      nl: 'Niemand',
      de: 'Niemand'
    },
    /** Said when the card was read again and is gone, or was archived elsewhere. */
    cardGone: {
      en: 'This card is no longer on the board.',
      nl: 'Deze kaart staat niet meer op het bord.',
      de: 'Diese Karte ist nicht mehr auf dem Board.'
    },
    /** A card's line under its title: who has it and how urgent. */
    cardMeta: {
      en: ({ assignee, priority }: { assignee: string; priority: number }) =>
        assignee ? `${assignee} · priority ${priority}` : `Priority ${priority}`,
      nl: ({ assignee, priority }: { assignee: string; priority: number }) =>
        assignee ? `${assignee} · prioriteit ${priority}` : `Prioriteit ${priority}`,
      de: ({ assignee, priority }: { assignee: string; priority: number }) =>
        assignee ? `${assignee} · Priorität ${priority}` : `Priorität ${priority}`
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
