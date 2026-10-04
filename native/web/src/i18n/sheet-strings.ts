/**
 * Strings only the web client has, that only a sheet or a page loaded as a chunk
 * of its own says: the request sheets (`features/requests/sheets.ts`, and the
 * passkey confirmation's `ConfirmSheet`) and the passkeys page
 * (`features/settings/Passkeys.tsx`).
 *
 * The same table as `web-strings.ts`, under the same rules (one leaf, three
 * languages; `web-strings.test.ts` reads both), kept apart so that none of it is
 * in the first load. **Only a module that is itself loaded on demand may import
 * this file**: one import from the entry's graph puts all of it back there
 * (`npm run client:check-bundle` would show it). A string that the entry also
 * says belongs in `web-strings.ts`.
 */
import { type Branch, localise, type Translated } from './web-strings'

/** The strings, as written: every leaf in en, nl and de. */
export const SHEET_STRINGS_SOURCE = {
  /**
   * The composer's refusal for a chat another Hermes window or terminal has open (`features/chat/Composer`,
   * in the chat screen's chunk): the gateway's code 4090 `SESSION_NOT_OWNED`, said in a sentence of our own
   * with the gateway's details line under it and the way out.
   */
  composer: {
    ownedElsewhere: {
      sentence: {
        en: 'This chat is open in another Hermes window or terminal, so the message did not go out. Use it there, or start a new chat here.',
        nl: 'Deze chat is open in een ander Hermes-venster of een terminal, dus het bericht is niet verstuurd. Gebruik hem daar, of begin hier een nieuwe chat.',
        de: 'Dieser Chat ist in einem anderen Hermes-Fenster oder Terminal geöffnet, deshalb wurde die Nachricht nicht gesendet. Nutze ihn dort oder beginne hier einen neuen Chat.'
      },
      /** The gateway's own line about who has the chat open, as it sent it. */
      details: {
        en: ({ detail }: { detail: string }) => `Details: ${detail}`,
        nl: ({ detail }: { detail: string }) => `Details: ${detail}`,
        de: ({ detail }: { detail: string }) => `Details: ${detail}`
      },
      startNewChat: {
        en: 'Start new chat',
        nl: 'Nieuwe chat beginnen',
        de: 'Neuen Chat beginnen'
      }
    }
  },
  /**
   * The options of a chat's own session beyond YOLO: reasoning effort and the model
   * (`features/chat/ConversationOptions`, in the options panel's chunk). Their names and hints, and the
   * export's, come from the shared catalogue.
   */
  chatSettings: {
    /** The reasoning efforts the gateway takes, in its own order. */
    reasoning: {
      none: {
        en: 'Off',
        nl: 'Uit',
        de: 'Aus'
      },
      minimal: {
        en: 'Minimal',
        nl: 'Minimaal',
        de: 'Minimal'
      },
      low: {
        en: 'Low',
        nl: 'Laag',
        de: 'Niedrig'
      },
      medium: {
        en: 'Medium',
        nl: 'Gemiddeld',
        de: 'Mittel'
      },
      high: {
        en: 'High',
        nl: 'Hoog',
        de: 'Hoch'
      },
      xhigh: {
        en: 'Extra high',
        nl: 'Extra hoog',
        de: 'Extra hoch'
      },
      max: {
        en: 'Max',
        nl: 'Max',
        de: 'Max'
      },
      ultra: {
        en: 'Ultra',
        nl: 'Ultra',
        de: 'Ultra'
      }
    },
    /** The reasoning picker's line while the session has not reported an effort. */
    reasoningUnset: {
      en: 'Not reported',
      nl: 'Niet opgegeven',
      de: 'Nicht gemeldet'
    },
    /** Under the model picker while the gateway's inventory is on its way. */
    modelsLoading: {
      en: 'Loading models…',
      nl: 'Modellen laden…',
      de: 'Modelle werden geladen…'
    },
    /** The model search found nothing but the model the chat is on. */
    modelsNoMatch: {
      en: 'No other model matches.',
      nl: 'Geen ander model komt overeen.',
      de: 'Kein anderes Modell passt.'
    }
  },
  rowMenu: {
    markRead: {
      en: 'Mark as read',
      nl: 'Markeren als gelezen',
      de: 'Als gelesen markieren'
    },
    pin: {
      en: 'Pin',
      nl: 'Vastzetten',
      de: 'Anheften'
    },
    unpin: {
      en: 'Unpin',
      nl: 'Losmaken',
      de: 'Lösen'
    },
    unmute: {
      en: 'Unmute',
      nl: 'Niet meer dempen',
      de: 'Stummschaltung aufheben'
    },
    editProfile: {
      en: 'Edit profile',
      nl: 'Profiel bewerken',
      de: 'Profil bearbeiten'
    },
    /** The last line of the row menu's Move to folder list: it opens a small form that names the folder. */
    newFolderItem: {
      en: 'New folder…',
      nl: 'Nieuwe map…',
      de: 'Neuer Ordner…'
    },
    /** The form's button. */
    createFolder: {
      en: 'Create',
      nl: 'Maken',
      de: 'Erstellen'
    },
    /** Said politely once the folder has been made around the chat. */
    folderCreated: {
      en: ({ name, folder }: { name: string; folder: string }) => `${name} is now in the new folder ${folder}.`,
      nl: ({ name, folder }: { name: string; folder: string }) => `${name} staat nu in de nieuwe map ${folder}.`,
      de: ({ name, folder }: { name: string; folder: string }) => `${name} ist jetzt im neuen Ordner ${folder}.`
    },
    /** In the row menu's Mute, Colour and Move to folder lists: the way back to the first list. */
    back: {
      en: 'Back',
      nl: 'Terug',
      de: 'Zurück'
    },
    /** Said politely once Mark as read has been chosen. */
    markedRead: {
      en: ({ name }: { name: string }) => `${name} marked as read.`,
      nl: ({ name }: { name: string }) => `${name} is als gelezen gemarkeerd.`,
      de: ({ name }: { name: string }) => `${name} als gelesen markiert.`
    },
    pinned: {
      en: ({ name }: { name: string }) => `${name} pinned.`,
      nl: ({ name }: { name: string }) => `${name} is vastgezet.`,
      de: ({ name }: { name: string }) => `${name} angepinnt.`
    },
    unpinned: {
      en: ({ name }: { name: string }) => `${name} unpinned.`,
      nl: ({ name }: { name: string }) => `${name} is niet meer vastgezet.`,
      de: ({ name }: { name: string }) => `${name} ist nicht mehr angepinnt.`
    },
    /** `duration` is the menu's own words for it ("For 1 hour"). */
    muted: {
      en: ({ name, duration }: { name: string; duration: string }) => `${name} muted. ${duration}.`,
      nl: ({ name, duration }: { name: string; duration: string }) => `${name} is gedempt. ${duration}.`,
      de: ({ name, duration }: { name: string; duration: string }) => `${name} stummgeschaltet. ${duration}.`
    },
    unmuted: {
      en: ({ name }: { name: string }) => `${name} unmuted.`,
      nl: ({ name }: { name: string }) => `${name} is niet meer gedempt.`,
      de: ({ name }: { name: string }) => `${name} ist nicht mehr stummgeschaltet.`
    },
    coloured: {
      en: ({ name, colour }: { name: string; colour: string }) => `Colour of ${name} set to ${colour}.`,
      nl: ({ name, colour }: { name: string; colour: string }) => `Kleur van ${name} is nu ${colour}.`,
      de: ({ name, colour }: { name: string; colour: string }) => `Farbe von ${name} ist jetzt ${colour}.`
    }
  },
  botProfile: {
    /** The personality (`SOUL.md`): the instructions that give a bot its character. Words follow the native apps'. */
    personalityHeading: {
      en: 'Personality',
      nl: 'Persoonlijkheid',
      de: 'Persönlichkeit'
    },
    personalityHint: {
      en: 'The instructions that give this bot its character: the SOUL.md of its profile on the gateway. Shown as plain text.',
      nl: 'De instructies die deze bot zijn karakter geven: het SOUL.md-bestand van zijn profiel op de gateway. Wordt als gewone tekst getoond.',
      de: 'Die Anweisungen, die diesem Bot seinen Charakter geben: die SOUL.md seines Profils auf dem Gateway. Wird als reiner Text angezeigt.'
    },
    personalityEmpty: {
      en: 'No personality is set.',
      nl: 'Er is geen persoonlijkheid ingesteld.',
      de: 'Es ist keine Persönlichkeit festgelegt.'
    },
    personalitySaved: {
      en: 'Personality saved.',
      nl: 'Persoonlijkheid opgeslagen.',
      de: 'Persönlichkeit gespeichert.'
    },
    /** The bot's own model: what its chats start on. */
    modelHeading: {
      en: 'Model',
      nl: 'Model',
      de: 'Modell'
    },
    modelLead: {
      en: 'The model this bot starts its chats on. A single chat can still pick another one in its own options.',
      nl: 'Het model waarmee deze bot zijn chats begint. Een los gesprek kan in zijn eigen opties nog een ander model kiezen.',
      de: 'Das Modell, mit dem dieser Bot seine Chats beginnt. Ein einzelner Chat kann in seinen eigenen Optionen noch ein anderes wählen.'
    },
    modelFollows: {
      en: 'Follows the gateway’s model',
      nl: 'Volgt het model van de gateway',
      de: 'Folgt dem Modell des Gateways'
    },
    modelUnavailable: {
      en: 'This gateway does not list the models it offers, so the model cannot be changed here.',
      nl: 'Deze gateway toont niet welke modellen hij aanbiedt, dus het model kan hier niet worden gewijzigd.',
      de: 'Dieses Gateway listet seine Modelle nicht auf, daher lässt sich das Modell hier nicht ändern.'
    },
    modelChanged: {
      en: 'Model changed.',
      nl: 'Model gewijzigd.',
      de: 'Modell geändert.'
    },
    /** A model the bot is on that the gateway does not list: still the one it is on. */
    modelNotListed: {
      en: ({ name }: { name: string }) => `${name} (not in the gateway’s list)`,
      nl: ({ name }: { name: string }) => `${name} (niet in de lijst van de gateway)`,
      de: ({ name }: { name: string }) => `${name} (nicht in der Liste des Gateways)`
    },
    descriptionPlaceholder: {
      en: 'What this bot is for',
      nl: 'Waar deze bot voor is',
      de: 'Wofür dieser Bot da ist'
    },
    gatewayVersion: {
      en: 'Gateway',
      nl: 'Gateway',
      de: 'Gateway'
    },
    model: {
      en: 'Model',
      nl: 'Model',
      de: 'Modell'
    },
    photoChange: {
      en: 'Choose a photo',
      nl: 'Kies een foto',
      de: 'Foto auswählen'
    },
    photoFailed: {
      en: 'That photo could not be uploaded.',
      nl: 'Die foto kon niet worden geüpload.',
      de: 'Dieses Foto konnte nicht hochgeladen werden.'
    },
    photoHint: {
      en: 'Shown on the chat list, the header and every message this bot sends.',
      nl: 'Te zien in de chatlijst, in de koptekst en bij elk bericht dat deze bot stuurt.',
      de: 'Zu sehen in der Chatliste, im Header und bei jeder Nachricht, die dieser Bot sendet.'
    },
    photoRemove: {
      en: 'Remove photo',
      nl: 'Foto verwijderen',
      de: 'Foto entfernen'
    },
    photoReplace: {
      en: 'Change photo',
      nl: 'Foto wijzigen',
      de: 'Foto ändern'
    },
    provider: {
      en: 'Provider',
      nl: 'Provider',
      de: 'Provider'
    },
    save: {
      en: 'Save',
      nl: 'Opslaan',
      de: 'Speichern'
    },
    saveFailed: {
      en: 'The gateway would not save that.',
      nl: 'De gateway wilde dat niet opslaan.',
      de: 'Das Gateway wollte das nicht speichern.'
    },
    saving: {
      en: 'Saving…',
      nl: 'Opslaan…',
      de: 'Speichere…'
    },
    session: {
      en: 'Session',
      nl: 'Sessie',
      de: 'Session'
    },
    profileLink: {
      en: 'Profile',
      nl: 'Profiel',
      de: 'Profil'
    },
    unknown: {
      en: '—',
      nl: '—',
      de: '—'
    },
    colourOf: {
      en: ({ name }: { name: string }) => `Colour for ${name}`,
      nl: ({ name }: { name: string }) => `Kleur voor ${name}`,
      de: ({ name }: { name: string }) => `Farbe für ${name}`
    },
    displayLabel: {
      en: 'Display name',
      nl: 'Weergavenaam',
      de: 'Anzeigename'
    },
    displayHint: {
      en: 'What Hermie calls this bot in your list. The gateway keeps the profile’s own name.',
      nl: 'Hoe deze bot in jouw lijst heet. De gateway houdt de eigen naam van het profiel.',
      de: 'Wie dieser Bot in deiner Liste heißt. Das Gateway behält den eigenen Namen des Profils.'
    },
    clearHint: {
      en: 'Leave it empty to fall back to the name the gateway reports.',
      nl: 'Laat het leeg om terug te vallen op de naam die de gateway doorgeeft.',
      de: 'Leer lassen, um auf den Namen zurückzufallen, den das Gateway meldet.'
    },
    profileLabel: {
      en: 'Profile name',
      nl: 'Profielnaam',
      de: 'Profilname'
    },
    profileHint: {
      en: 'The name the rest of the app addresses this bot by.',
      nl: 'De naam waarmee de rest van de app deze bot aanspreekt.',
      de: 'Der Name, unter dem der Rest der App diesen Bot anspricht.'
    },
    missing: {
      en: ({ name }: { name: string }) => `The gateway has no profile called ${name}.`,
      nl: ({ name }: { name: string }) => `De gateway heeft geen profiel dat ${name} heet.`,
      de: ({ name }: { name: string }) => `Das Gateway kennt kein Profil namens ${name}.`
    },
    readFailed: {
      en: ({ reason }: { reason: string }) => `Could not read the configuration: ${reason}`,
      nl: ({ reason }: { reason: string }) => `Kon de configuratie niet lezen: ${reason}`,
      de: ({ reason }: { reason: string }) => `Die Konfiguration konnte nicht gelesen werden: ${reason}`
    },
    loading: {
      en: 'Reading this bot’s configuration…',
      nl: 'De configuratie van deze bot lezen…',
      de: 'Konfiguration dieses Bots wird gelesen…'
    },
    refused: {
      en: ({ reason }: { reason: string }) => `The gateway refused the change: ${reason}`,
      nl: ({ reason }: { reason: string }) => `De gateway weigerde de wijziging: ${reason}`,
      de: ({ reason }: { reason: string }) => `Das Gateway hat die Änderung abgelehnt: ${reason}`
    },
    capabilitiesHeading: {
      en: 'Capabilities',
      nl: 'Mogelijkheden',
      de: 'Fähigkeiten'
    },
    toolCount: {
      en: ({ count }: { count: number }) => (count === 1 ? `1 tool` : `${count} tools`),
      nl: ({ count }: { count: number }) => (count === 1 ? `1 tool` : `${count} tools`),
      de: ({ count }: { count: number }) => (count === 1 ? `1 Tool` : `${count} Tools`)
    },
    toolsetsPinned: {
      en: 'Pinned for this bot.',
      nl: 'Vastgezet voor deze bot.',
      de: 'Für diesen Bot fixiert.'
    },
    toolsetsUnpinned: {
      en: 'This bot follows the gateway’s defaults. Changing a switch pins the whole list.',
      nl: 'Deze bot volgt de standaard van de gateway. Eén schakelaar omzetten zet de hele lijst vast.',
      de: 'Dieser Bot folgt den Vorgaben des Gateways. Ein Schalter, den du umlegst, fixiert die ganze Liste.'
    },
    skillsEmpty: {
      en: 'No skills installed for this bot.',
      nl: 'Geen skills geïnstalleerd voor deze bot.',
      de: 'Für diesen Bot sind keine Skills installiert.'
    },
    skillsFooter: {
      en: 'Skills are folders of instructions the bot can open when it needs them.',
      nl: 'Skills zijn mappen met instructies die de bot kan openen wanneer hij ze nodig heeft.',
      de: 'Skills sind Ordner mit Anweisungen, die der Bot öffnen kann, wenn er sie braucht.'
    },
    mcpEmpty: {
      en: 'No MCP servers configured on this gateway.',
      nl: 'Geen MCP-servers ingesteld op deze gateway.',
      de: 'Auf diesem Gateway sind keine MCP-Server konfiguriert.'
    },
    mcpFooter: {
      en: 'Switching a server on here makes its tools available to this bot.',
      nl: 'Een server hier aanzetten maakt zijn tools beschikbaar voor deze bot.',
      de: 'Einen Server hier einzuschalten macht seine Tools für diesen Bot verfügbar.'
    },
    reloadTitle: {
      en: 'Apply to running chats?',
      nl: 'Toepassen op lopende chats?',
      de: 'Auf laufende Chats anwenden?'
    },
    reloadBody: {
      en: 'MCP servers reload for every live chat. The next message in each one re-sends its full input.',
      nl: 'MCP-servers herladen voor elke lopende chat. Het volgende bericht in elke chat stuurt zijn volledige invoer opnieuw.',
      de: 'MCP-Server werden für jeden laufenden Chat neu geladen. Die nächste Nachricht in jedem Chat sendet ihre gesamte Eingabe erneut.'
    },
    reloadNow: {
      en: 'Reload now',
      nl: 'Nu herladen',
      de: 'Neu laden'
    },
    reloadAlways: {
      en: 'Reload, and stop asking',
      nl: 'Herladen, en niet meer vragen',
      de: 'Neu laden, nicht fragen'
    },
    reloadAlwaysHint: {
      en: 'Stops the gateway asking again — in the CLI and the desktop app too.',
      nl: 'Zorgt dat de gateway het niet meer vraagt — ook niet in de CLI en de desktopapp.',
      de: 'Das Gateway fragt dann nicht mehr — auch nicht in der CLI und der Desktop-App.'
    },
    reloadLater: {
      en: 'Not now',
      nl: 'Nu niet',
      de: 'Später'
    },
    reloadDone: {
      en: 'MCP servers reloaded.',
      nl: 'MCP-servers zijn herladen.',
      de: 'MCP-Server neu geladen.'
    },
    /** At the top of the profile page: the way back to the chat. */
    backToChat: {
      en: 'Back to chat',
      nl: 'Terug naar chat',
      de: 'Zurück zum Chat'
    },
    /** Section headings. */
    photoHeading: {
      en: 'Photo',
      nl: 'Foto',
      de: 'Foto'
    },
    nameHeading: {
      en: 'Name',
      nl: 'Naam',
      de: 'Name'
    },
    descriptionHeading: {
      en: 'Description',
      nl: 'Beschrijving',
      de: 'Beschreibung'
    },
    colourHeading: {
      en: 'Colour',
      nl: 'Kleur',
      de: 'Farbe'
    },
    toolsetsHeading: {
      en: 'Toolsets',
      nl: 'Toolsets',
      de: 'Toolsets'
    },
    skillsHeading: {
      en: 'Skills',
      nl: 'Skills',
      de: 'Skills'
    },
    mcpHeading: {
      en: 'MCP servers',
      nl: 'MCP-servers',
      de: 'MCP-Server'
    },
    aboutHeading: {
      en: 'About this bot',
      nl: 'Over deze bot',
      de: 'Über diesen Bot'
    },
    /** Under the colours: where it shows on this client. */
    colourHint: {
      en: 'Shown as a stripe on this chat’s row, and kept with your other devices.',
      nl: 'Zichtbaar als streep op de rij van deze chat, en bewaard voor je andere apparaten.',
      de: 'Wird als Streifen an der Zeile dieses Chats gezeigt und mit deinen anderen Geräten abgeglichen.'
    },
    /** The picture could not be taken: not an image, or too large to send. */
    photoNotImage: {
      en: 'That file is not a picture.',
      nl: 'Dat bestand is geen afbeelding.',
      de: 'Diese Datei ist kein Bild.'
    },
    photoTooLarge: {
      en: 'That picture is too large to send.',
      nl: 'Die afbeelding is te groot om te versturen.',
      de: 'Das Bild ist zu groß zum Senden.'
    },
    photoUploading: {
      en: 'Saving the photo…',
      nl: 'De foto wordt opgeslagen…',
      de: 'Das Foto wird gespeichert…'
    },
    photoChanged: {
      en: 'Photo changed.',
      nl: 'Foto gewijzigd.',
      de: 'Foto geändert.'
    },
    photoRemoved: {
      en: 'Photo removed.',
      nl: 'Foto verwijderd.',
      de: 'Foto entfernt.'
    },
    revert: {
      en: 'Revert',
      nl: 'Terugzetten',
      de: 'Zurücksetzen'
    },
    descriptionSaved: {
      en: 'Description saved.',
      nl: 'Beschrijving opgeslagen.',
      de: 'Beschreibung gespeichert.'
    },
    /** The reader's own name for the bot was cleared or changed. */
    nameSaved: {
      en: 'Name saved.',
      nl: 'Naam opgeslagen.',
      de: 'Name gespeichert.'
    },
    /** The toolsets list, when the bot has none of its own: what a switch will do. */
    useDefaults: {
      en: 'Use the gateway’s defaults',
      nl: 'Standaardinstellingen van de gateway gebruiken',
      de: 'Standardeinstellungen des Gateways verwenden'
    },
    /** A switch that would leave no toolset on: nothing was sent. */
    lastToolset: {
      en: 'One toolset has to stay on: the gateway reads an empty list as its defaults. Use the gateway’s defaults to follow them instead.',
      nl: 'Eén toolset moet aan blijven: de gateway leest een lege lijst als zijn standaardinstellingen. Gebruik de standaardinstellingen van de gateway om die te volgen.',
      de: 'Ein Toolset muss eingeschaltet bleiben: Das Gateway liest eine leere Liste als seine Standardeinstellungen. Verwende stattdessen die Standardeinstellungen des Gateways.'
    },
    /** The Skills toolset is off: the skills below do nothing for the bot's own tools. */
    skillsToolsetOff: {
      en: 'The Skills toolset is off, so this bot gets no skill tools whatever the switches below say.',
      nl: 'De toolset Skills staat uit, dus deze bot krijgt geen skill-tools, wat de schakelaars hieronder ook zeggen.',
      de: 'Das Toolset Skills ist ausgeschaltet, dieser Bot bekommt also keine Skill-Tools, was die Schalter unten auch sagen.'
    },
    /** The reader's own words for why the form cannot be changed. */
    readOnly: {
      en: 'This gateway account may look at this bot and not change it. Name and colour are yours and still work.',
      nl: 'Dit gatewayaccount mag deze bot bekijken en niet wijzigen. Naam en kleur zijn van jou en werken nog.',
      de: 'Dieses Gateway-Konto darf diesen Bot ansehen, aber nicht ändern. Name und Farbe gehören dir und funktionieren weiter.'
    },
    offline: {
      en: 'Not connected, so what the gateway keeps for this bot cannot be changed right now.',
      nl: 'Geen verbinding, dus wat de gateway van deze bot bewaart kan nu niet worden gewijzigd.',
      de: 'Nicht verbunden, deshalb lässt sich im Moment nicht ändern, was das Gateway zu diesem Bot speichert.'
    },
    unsupported: {
      en: 'This gateway does not offer profile editing, so only the name and colour can be changed here.',
      nl: 'Deze gateway biedt geen profielbewerking, dus hier kunnen alleen naam en kleur worden gewijzigd.',
      de: 'Dieses Gateway bietet keine Profilbearbeitung, deshalb lassen sich hier nur Name und Farbe ändern.'
    },
    /** A write the gateway answered without applying. */
    notApplied: {
      en: 'The gateway did not apply that change.',
      nl: 'De gateway heeft die wijziging niet toegepast.',
      de: 'Das Gateway hat diese Änderung nicht übernommen.'
    },
    /** A write that never reached the gateway. */
    notSent: {
      en: 'There was no connection, so nothing was changed.',
      nl: 'Er was geen verbinding, dus er is niets gewijzigd.',
      de: 'Es gab keine Verbindung, deshalb wurde nichts geändert.'
    }
  },
  /**
   * The New bot page (`features/profile/NewBotPage.tsx`): what a handle that cannot be used is told, in the
   * words of the gateway's own rules. The labels, the hints and the buttons are the catalogue's
   * (`strings.profiles.new`).
   */
  newBot: {
    /** The gateway is not reachable: nothing can be made, and the button says so by being off. */
    offline: {
      en: 'Not connected to the gateway, so a bot cannot be made right now.',
      nl: 'Geen verbinding met de gateway, dus er kan nu geen bot worden gemaakt.',
      de: 'Nicht mit dem Gateway verbunden, deshalb kann im Moment kein Bot angelegt werden.'
    },
    /** Why a handle cannot be used: upstream's validator, as sentences. */
    problem: {
      empty: {
        en: 'A bot needs a handle.',
        nl: 'Een bot heeft een handle nodig.',
        de: 'Ein Bot braucht ein Handle.'
      },
      default: {
        en: '“default” is the built-in bot and cannot be made again.',
        nl: '“default” is de ingebouwde bot en kan niet opnieuw worden gemaakt.',
        de: '„default“ ist der eingebaute Bot und kann nicht noch einmal angelegt werden.'
      },
      invalid: {
        en: ({ suggestion }: { suggestion: string }) =>
          `Use lowercase letters, numbers, “-” or “_”, starting with a letter or number, up to 64 characters (for example: ${suggestion}).`,
        nl: ({ suggestion }: { suggestion: string }) =>
          `Gebruik kleine letters, cijfers, “-” of “_”, beginnend met een letter of cijfer, tot 64 tekens (bijvoorbeeld: ${suggestion}).`,
        de: ({ suggestion }: { suggestion: string }) =>
          `Nutze Kleinbuchstaben, Ziffern, „-“ oder „_“, beginnend mit einem Buchstaben oder einer Ziffer, bis zu 64 Zeichen (zum Beispiel: ${suggestion}).`
      },
      reserved: {
        en: ({ name }: { name: string }) =>
          `“${name}” is reserved: it collides with Hermes itself or with a common system command.`,
        nl: ({ name }: { name: string }) =>
          `“${name}” is gereserveerd: het botst met Hermes zelf of met een gangbaar systeemcommando.`,
        de: ({ name }: { name: string }) =>
          `„${name}“ ist reserviert: Es kollidiert mit Hermes selbst oder mit einem gängigen Systembefehl.`
      },
      taken: {
        en: ({ name }: { name: string }) => `“${name}” already exists.`,
        nl: ({ name }: { name: string }) => `“${name}” bestaat al.`,
        de: ({ name }: { name: string }) => `„${name}“ gibt es schon.`
      }
    },
    /** A legal handle that is also a `hermes` subcommand: the shortcut is not made, the bot is fine. */
    subcommand: {
      en: ({ name }: { name: string }) =>
        `“${name}” is also a hermes subcommand, so the shortcut “hermes ${name}” will not be created. The bot itself is fine.`,
      nl: ({ name }: { name: string }) =>
        `“${name}” is ook een hermes-subcommando, dus de snelkoppeling “hermes ${name}” wordt niet gemaakt. De bot zelf werkt gewoon.`,
      de: ({ name }: { name: string }) =>
        `„${name}“ ist auch ein hermes-Unterbefehl, deshalb wird die Verknüpfung „hermes ${name}“ nicht angelegt. Der Bot selbst funktioniert trotzdem.`
    },
    /** The gateway made the bot and the roster did not list it. */
    notListed: {
      en: ({ name }: { name: string }) =>
        `The gateway made ${name} but did not list it. Try the chat list again in a moment.`,
      nl: ({ name }: { name: string }) =>
        `De gateway heeft ${name} gemaakt maar toont hem niet in de lijst. Probeer de chatlijst zo nog eens.`,
      de: ({ name }: { name: string }) =>
        `Das Gateway hat ${name} angelegt, listet ihn aber nicht auf. Versuch es gleich noch einmal mit der Chatliste.`
    },
    /** After a create that left the bot without a model: said before the chat is offered. */
    created: {
      en: ({ name }: { name: string }) => `${name} is made.`,
      nl: ({ name }: { name: string }) => `${name} is gemaakt.`,
      de: ({ name }: { name: string }) => `${name} ist angelegt.`
    }
  },
  /**
   * The choice between the shared Bot Chat and the reader's own (`features/chat/ChatChoice.tsx`): what is said once
   * a switch has happened. The labels, the notes and the busy sentence are the catalogue's (`strings.chat.sessions`).
   */
  chatChoice: {
    /**
     * The group's name. Not the catalogue's "This conversation", which the options panel already uses for the
     * heading of its session options: two groups of one panel with one name cannot be told apart by ear.
     */
    legend: {
      en: 'Whose chat',
      nl: 'Van wie de chat is',
      de: 'Wessen Chat'
    },
    nowMine: {
      en: 'Now in your own chat.',
      nl: 'Nu in je eigen chat.',
      de: 'Jetzt in deinem eigenen Chat.'
    },
    nowShared: {
      en: 'Now in the shared Bot Chat.',
      nl: 'Nu in de gedeelde Bot Chat.',
      de: 'Jetzt im gemeinsamen Bot Chat.'
    }
  },
  /**
   * The Agents bar over a chat's composer and the panel it opens (`features/chat/AgentsBar.tsx`, in the chat
   * screen's chunk). The words it shares with the apps (the count, Show, the statuses, Steer, Stop, the transcript's
   * two sources) are the catalogue's (`strings.chat.subagents`).
   */
  agents: {
    /** The bar's button while the panel is open (it reads Show while it is closed). */
    hide: {
      en: 'Hide',
      nl: 'Verbergen',
      de: 'Ausblenden'
    },
    /** What a Steer or a Stop the gateway did not take is told, with the gateway's own words after it. */
    actionFailed: {
      en: ({ reason }: { reason: string }) => `That did not go through: ${reason}`,
      nl: ({ reason }: { reason: string }) => `Dat is niet gelukt: ${reason}`,
      de: ({ reason }: { reason: string }) => `Das hat nicht geklappt: ${reason}`
    },
    /** The open transcript could not be read; the last text stays and the next read tries again. */
    readFailed: {
      en: ({ reason }: { reason: string }) => `Could not read the transcript: ${reason}`,
      nl: ({ reason }: { reason: string }) => `Het transcript kon niet worden gelezen: ${reason}`,
      de: ({ reason }: { reason: string }) => `Das Transkript konnte nicht gelesen werden: ${reason}`
    },
    /** Said once a transcript is being read for the first time. */
    loading: {
      en: 'Reading the transcript…',
      nl: 'Het transcript wordt gelezen…',
      de: 'Das Transkript wird gelesen…'
    }
  },
  requests: {
    /** A clarify question left unanswered on purpose: the bot is told "no answer". */
    skip: {
      en: 'Skip',
      nl: 'Overslaan',
      de: 'Überspringen'
    },
    /** On an approval the gateway's own safety check refused (`smart_denied`): the reader is the override. */
    smartDenied: {
      en: 'The gateway’s own safety check refused this command. It runs only if you allow it here.',
      nl: 'De eigen veiligheidscontrole van de gateway heeft dit commando geweigerd. Het draait alleen als jij het hier toestaat.',
      de: 'Die eigene Sicherheitsprüfung des Gateways hat diesen Befehl abgelehnt. Er läuft nur, wenn du ihn hier erlaubst.'
    },
    /** Under the choices, when "Allow for this session" is one of them: what it means, apart from "Always allow". */
    sessionHint: {
      en: 'Allow for this session: this command runs without asking again until the session ends.',
      nl: 'Toestaan voor deze sessie: dit commando draait zonder opnieuw te vragen tot de sessie eindigt.',
      de: 'Für diese Sitzung erlauben: Dieser Befehl läuft ohne erneute Nachfrage, bis die Sitzung endet.'
    },
    /** The box that makes one answer apply to the other approvals waiting from the same bot. Off by default. */
    sameForAll: {
      en: ({ count, name }: { count: number; name: string }) =>
        count === 1
          ? `Give the same answer to the other approval waiting from ${name}`
          : `Give the same answer to the ${count} other approvals waiting from ${name}`,
      nl: ({ count, name }: { count: number; name: string }) =>
        count === 1
          ? `Geef hetzelfde antwoord op de andere goedkeuring die van ${name} wacht`
          : `Geef hetzelfde antwoord op de ${count} andere goedkeuringen die van ${name} wachten`,
      de: ({ count, name }: { count: number; name: string }) =>
        count === 1
          ? `Dieselbe Antwort für die andere wartende Freigabe von ${name} geben`
          : `Dieselbe Antwort für die ${count} anderen wartenden Freigaben von ${name} geben`
    },
    /** Said politely when the list a ticked box covered changed: the tick was taken back. */
    othersChanged: {
      en: ({ name }: { name: string }) =>
        `The other approvals waiting from ${name} changed, so the box was cleared. Tick it again to see and answer them together.`,
      nl: ({ name }: { name: string }) =>
        `De andere goedkeuringen die van ${name} wachten zijn veranderd, dus het vakje is leeggemaakt. Vink het opnieuw aan om ze samen te zien en te beantwoorden.`,
      de: ({ name }: { name: string }) =>
        `Die anderen wartenden Freigaben von ${name} haben sich geändert, daher wurde das Kästchen geleert. Hake es erneut an, um sie zusammen zu sehen und zu beantworten.`
    },
    /** Over the list of the other commands that answer would also cover. */
    othersLabel: {
      en: 'That answer also goes to:',
      nl: 'Dat antwoord geldt ook voor:',
      de: 'Diese Antwort gilt auch für:'
    },
    /** Ends a batch of questions without answering any of them: the bot is told the reader declined. */
    cancelAll: {
      en: 'Cancel all questions',
      nl: 'Alle vragen annuleren',
      de: 'Alle Fragen abbrechen'
    }
  },
  passkeys: {
    /** The name of the box with the confirmation's detail, shown exactly as the gateway sent it. */
    detailLabel: {
      en: 'Details',
      nl: 'Details',
      de: 'Details'
    },
    /** The name of the box with the structured fields (an amount, a recipient, a model, ...) the bot sent. */
    fieldsLabel: {
      en: 'Key facts from the bot',
      nl: 'Kerngegevens van de bot',
      de: 'Eckdaten vom Bot'
    },
    /** Copies the detail exactly as the gateway sent it (not the drawing with its whitespace markers). */
    copyDetail: {
      en: 'Copy details',
      nl: 'Details kopiëren',
      de: 'Details kopieren'
    },
    detailCopied: {
      en: 'The details were copied.',
      nl: 'De details zijn gekopieerd.',
      de: 'Die Details wurden kopiert.'
    },
    detailNotCopied: {
      en: 'The details could not be copied.',
      nl: 'De details konden niet worden gekopieerd.',
      de: 'Die Details konnten nicht kopiert werden.'
    },
    /** Under a detail too big for its box: the size of the text as the gateway sent it. */
    detailSize: {
      en: ({ lines, longest }: { lines: number; longest: number }) =>
        `${lines} ${lines === 1 ? 'line' : 'lines'} · longest line ${longest} ${longest === 1 ? 'character' : 'characters'}`,
      nl: ({ lines, longest }: { lines: number; longest: number }) =>
        `${lines} ${lines === 1 ? 'regel' : 'regels'} · langste regel ${longest} ${longest === 1 ? 'teken' : 'tekens'}`,
      de: ({ lines, longest }: { lines: number; longest: number }) =>
        `${lines} ${lines === 1 ? 'Zeile' : 'Zeilen'} · längste Zeile ${longest} Zeichen`
    },
    /** The marker line that stands for 3 or more blank lines in a row inside the detail, between `⋯`. */
    emptyLines: {
      en: ({ count }: { count: number }) => `⋯ ${count} empty lines ⋯`,
      nl: ({ count }: { count: number }) => `⋯ ${count} lege regels ⋯`,
      de: ({ count }: { count: number }) => `⋯ ${count} leere Zeilen ⋯`
    },
    /** Under the buttons while Confirm waits for the detail to be scrolled to its end. */
    scrollToConfirm: {
      en: 'Scroll to the end of the details to confirm.',
      nl: 'Scrol naar het einde van de details om te bevestigen.',
      de: 'Scrolle bis zum Ende der Details, um zu bestätigen.'
    },
    /** Which passkey the browser will ask for: the page's own host is the passkey's site. */
    rpLine: {
      en: ({ rp }: { rp: string }) => `Your browser will ask for your passkey for ${rp}.`,
      nl: ({ rp }: { rp: string }) => `Je browser vraagt om je passkey voor ${rp}.`,
      de: ({ rp }: { rp: string }) => `Dein Browser fragt nach deinem Passkey für ${rp}.`
    },
    confirm: {
      en: 'Confirm with passkey',
      nl: 'Bevestigen met passkey',
      de: 'Mit Passkey bestätigen'
    },
    decline: {
      en: 'Decline',
      nl: 'Weigeren',
      de: 'Ablehnen'
    },
    /** The countdown to the gateway's deadline, `1:42`. */
    expires: {
      en: ({ time }: { time: string }) => `Expires in ${time}`,
      nl: ({ time }: { time: string }) => `Verloopt over ${time}`,
      de: ({ time }: { time: string }) => `Läuft ab in ${time}`
    },
    /** While the browser's passkey sheet is up. */
    signing: {
      en: 'Waiting for your passkey…',
      nl: 'Wachten op je passkey…',
      de: 'Warte auf deinen Passkey…'
    },
    sending: {
      en: 'Sending…',
      nl: 'Versturen…',
      de: 'Wird gesendet…'
    },
    /** The gateway refused the assertion; the request is still open. `reason` is the contract's word. */
    refused: {
      en: ({ reason }: { reason: string }) => `The gateway did not accept this answer (${reason}). You can try again.`,
      nl: ({ reason }: { reason: string }) =>
        `De gateway nam dit antwoord niet aan (${reason}). Je kunt het opnieuw proberen.`,
      de: ({ reason }: { reason: string }) =>
        `Das Gateway hat diese Antwort nicht angenommen (${reason}). Du kannst es noch einmal versuchen.`
    },
    notSent: {
      en: ({ message }: { message: string }) => `The answer was not sent: ${message}. You can try again.`,
      nl: ({ message }: { message: string }) =>
        `Het antwoord is niet verstuurd: ${message}. Je kunt het opnieuw proberen.`,
      de: ({ message }: { message: string }) =>
        `Die Antwort wurde nicht gesendet: ${message}. Du kannst es noch einmal versuchen.`
    },
    /**
     * Instead of `notSent` once an answer carrying the passkey got no reply: it may have been delivered, so
     * nothing here may say that nothing was confirmed.
     */
    mayHaveArrived: {
      en: 'The answer may have reached the gateway. You can try again, or check whether the action ran.',
      nl: 'Het antwoord heeft de gateway misschien bereikt. Je kunt het opnieuw proberen, of nagaan of de actie is uitgevoerd.',
      de: 'Die Antwort hat das Gateway vielleicht erreicht. Du kannst es noch einmal versuchen oder prüfen, ob die Aktion ausgeführt wurde.'
    },
    /** The end of a confirmation whose answer may have arrived, without the gateway's verdict on it. */
    outcomeUnknown: {
      en: 'The answer may have reached the gateway. Check whether the action ran.',
      nl: 'Het antwoord heeft de gateway misschien bereikt. Ga na of de actie is uitgevoerd.',
      de: 'Die Antwort hat das Gateway vielleicht erreicht. Prüfe, ob die Aktion ausgeführt wurde.'
    },
    /** After `ok`: received and valid, NOT confirmed yet. */
    received: {
      en: 'Received. The gateway checks your passkey and carries on only if it holds.',
      nl: 'Ontvangen. De gateway controleert je passkey en gaat alleen verder als die klopt.',
      de: 'Empfangen. Das Gateway prüft deinen Passkey und macht nur weiter, wenn er stimmt.'
    },
    verificationFailed: {
      en: 'This confirmation did not count: the gateway could not verify it. Nothing was confirmed.',
      nl: 'Deze bevestiging telt niet: de gateway kon haar niet controleren. Er is niets bevestigd.',
      de: 'Diese Bestätigung zählt nicht: Das Gateway konnte sie nicht prüfen. Es wurde nichts bestätigt.'
    },
    tooManyAttempts: {
      en: 'Too many answers were refused. The request was closed and nothing was confirmed.',
      nl: 'Te veel antwoorden zijn geweigerd. Het verzoek is gesloten en er is niets bevestigd.',
      de: 'Zu viele Antworten wurden abgelehnt. Die Anfrage wurde geschlossen, es wurde nichts bestätigt.'
    },
    notAllowed: {
      en: 'This browser may not answer this request. Nothing was confirmed.',
      nl: 'Deze browser mag dit verzoek niet beantwoorden. Er is niets bevestigd.',
      de: 'Dieser Browser darf diese Anfrage nicht beantworten. Es wurde nichts bestätigt.'
    },
    unavailable: {
      en: ({ reason }: { reason: string }) =>
        `This browser cannot use a passkey for this request (${reason}). Nothing was confirmed.`,
      nl: ({ reason }: { reason: string }) =>
        `Deze browser kan voor dit verzoek geen passkey gebruiken (${reason}). Er is niets bevestigd.`,
      de: ({ reason }: { reason: string }) =>
        `Dieser Browser kann für diese Anfrage keinen Passkey verwenden (${reason}). Es wurde nichts bestätigt.`
    },
    settings: {
      intro: {
        en: 'A passkey lets this gateway check that it is really you before an agent does something it asked you to confirm. It stays in your browser or password manager; the gateway keeps only its public key.',
        nl: 'Met een passkey controleert deze gateway dat jij het echt bent voordat een agent iets doet wat je moest bevestigen. Hij blijft in je browser of wachtwoordbeheerder; de gateway bewaart alleen de publieke sleutel.',
        de: 'Mit einem Passkey prüft dieses Gateway, dass du es wirklich bist, bevor ein Agent etwas tut, das du bestätigen solltest. Er bleibt in deinem Browser oder Passwortmanager; das Gateway speichert nur den öffentlichen Schlüssel.'
      },
      notSupported: {
        en: 'Passkeys need this page open over HTTPS at the gateway’s own address, without a path in front, in a browser that supports them.',
        nl: 'Voor passkeys moet deze pagina via HTTPS op het eigen adres van de gateway openstaan, zonder pad ervoor, in een browser die ze ondersteunt.',
        de: 'Passkeys brauchen diese Seite über HTTPS unter der eigenen Adresse des Gateways, ohne vorangestellten Pfad, in einem Browser, der sie unterstützt.'
      },
      needsSignIn: {
        en: 'Passkeys belong to a person signed in to the gateway. This gateway has no sign-in, so there is nobody to add one for. Turn on sign-in on the gateway to use passkeys.',
        nl: 'Passkeys horen bij een persoon die op de gateway is ingelogd. Deze gateway heeft geen inlog, dus er is niemand om er een voor toe te voegen. Zet inloggen aan op de gateway om passkeys te gebruiken.',
        de: 'Passkeys gehören zu einer Person, die am Gateway angemeldet ist. Dieses Gateway hat keine Anmeldung, also gibt es niemanden, für den einer hinzugefügt werden kann. Schalte die Anmeldung am Gateway ein, um Passkeys zu nutzen.'
      },
      notOffered: {
        en: 'This gateway does not offer passkey confirmations.',
        nl: 'Deze gateway biedt geen bevestigingen met een passkey.',
        de: 'Dieses Gateway bietet keine Bestätigungen mit Passkey an.'
      },
      off: {
        en: ({ reason }: { reason: string }) => `Passkey confirmations are off on this gateway (${reason}).`,
        nl: ({ reason }: { reason: string }) => `Bevestigingen met een passkey staan uit op deze gateway (${reason}).`,
        de: ({ reason }: { reason: string }) => `Bestätigungen mit Passkey sind auf diesem Gateway aus (${reason}).`
      },
      rpNotAccepted: {
        en: ({ host }: { host: string }) =>
          `This gateway does not accept passkeys for ${host}. Ask whoever runs it to list this address.`,
        nl: ({ host }: { host: string }) =>
          `Deze gateway accepteert geen passkeys voor ${host}. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Dieses Gateway akzeptiert keine Passkeys für ${host}. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      baseUrlNotListed: {
        en: ({ host }: { host: string }) =>
          `This gateway does not list ${host} as an address for passkeys. Ask whoever runs it to add this address.`,
        nl: ({ host }: { host: string }) =>
          `Deze gateway heeft ${host} niet als adres voor passkeys in zijn lijst. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Dieses Gateway führt ${host} nicht als Adresse für Passkeys. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      /** A write the gateway refused (403 `origin_not_listed`): the page's address is not one of its passkey addresses. */
      originNotListed: {
        en: ({ host }: { host: string }) =>
          `The gateway refused this because it does not list ${host} as an address for passkeys. Ask whoever runs it to add this address.`,
        nl: ({ host }: { host: string }) =>
          `De gateway weigerde dit omdat hij ${host} niet als adres voor passkeys in zijn lijst heeft. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Das Gateway hat das abgelehnt, weil es ${host} nicht als Adresse für Passkeys führt. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      ready: {
        en: 'Passkey confirmations are on for this gateway.',
        nl: 'Bevestigingen met een passkey staan aan voor deze gateway.',
        de: 'Bestätigungen mit Passkey sind für dieses Gateway eingeschaltet.'
      },
      listTitle: {
        en: 'Your passkeys',
        nl: 'Je passkeys',
        de: 'Deine Passkeys'
      },
      empty: {
        en: 'You have no passkey on this gateway yet.',
        nl: 'Je hebt nog geen passkey op deze gateway.',
        de: 'Du hast noch keinen Passkey auf diesem Gateway.'
      },
      forSite: {
        en: ({ rp }: { rp: string }) => `For ${rp}`,
        nl: ({ rp }: { rp: string }) => `Voor ${rp}`,
        de: ({ rp }: { rp: string }) => `Für ${rp}`
      },
      added: {
        en: ({ date }: { date: string }) => `Added ${date}`,
        nl: ({ date }: { date: string }) => `Toegevoegd ${date}`,
        de: ({ date }: { date: string }) => `Hinzugefügt ${date}`
      },
      remove: {
        en: 'Remove',
        nl: 'Verwijderen',
        de: 'Entfernen'
      },
      /** The accessible name of a passkey's Remove button. */
      removeNamed: {
        en: ({ name }: { name: string }) => `Remove ${name}`,
        nl: ({ name }: { name: string }) => `${name} verwijderen`,
        de: ({ name }: { name: string }) => `${name} entfernen`
      },
      removed: {
        en: 'The passkey was removed.',
        nl: 'De passkey is verwijderd.',
        de: 'Der Passkey wurde entfernt.'
      },
      enrolTitle: {
        en: 'Add a passkey with a code',
        nl: 'Een passkey toevoegen met een code',
        de: 'Einen Passkey mit einem Code hinzufügen'
      },
      enrolHelp: {
        en: 'You need a one-time code from whoever runs the gateway, or one you made with a passkey you already have.',
        nl: 'Je hebt een eenmalige code nodig van wie de gateway beheert, of een die je met een bestaande passkey hebt gemaakt.',
        de: 'Du brauchst einen Einmalcode von der Person, die das Gateway betreibt, oder einen, den du mit einem vorhandenen Passkey erstellt hast.'
      },
      codeLabel: {
        en: 'Enrolment code',
        nl: 'Koppelcode',
        de: 'Registrierungscode'
      },
      enrol: {
        en: 'Add with a code',
        nl: 'Toevoegen met een code',
        de: 'Mit Code hinzufügen'
      },
      enrolled: {
        en: 'The passkey was added.',
        nl: 'De passkey is toegevoegd.',
        de: 'Der Passkey wurde hinzugefügt.'
      },
      /** Adding a passkey by signing in again (contract §7.2): the section's heading. */
      selfTitle: {
        en: 'Add a passkey',
        nl: 'Een passkey toevoegen',
        de: 'Einen Passkey hinzufügen'
      },
      selfHelp: {
        en: 'You will sign in again to prove it is you, then your browser creates the passkey.',
        nl: 'Je logt opnieuw in om te laten zien dat jij het bent; daarna maakt je browser de passkey.',
        de: 'Du meldest dich erneut an, um zu zeigen, dass du es bist; danach erstellt dein Browser den Passkey.'
      },
      selfStart: {
        en: 'Add a passkey',
        nl: 'Passkey toevoegen',
        de: 'Passkey hinzufügen'
      },
      /** The same button after a sign-in that did not count: a new one starts. */
      selfRetry: {
        en: 'Sign in again',
        nl: 'Opnieuw inloggen',
        de: 'Erneut anmelden'
      },
      /** While the window leaves for the gateway's sign-in page. */
      selfStarting: {
        en: 'Taking you to sign in…',
        nl: 'Je gaat naar het inloggen…',
        de: 'Weiter zur Anmeldung …'
      },
      selfFinishTitle: {
        en: 'Finish adding your passkey',
        nl: 'Je passkey afmaken',
        de: 'Deinen Passkey fertig hinzufügen'
      },
      selfFinishHelp: {
        en: ({ time }: { time: string }) =>
          `If you finished signing in again, add your passkey now. This works until ${time}.`,
        nl: ({ time }: { time: string }) =>
          `Als je klaar bent met opnieuw inloggen, voeg dan nu je passkey toe. Dit kan tot ${time}.`,
        de: ({ time }: { time: string }) =>
          `Wenn du die erneute Anmeldung abgeschlossen hast, füge jetzt deinen Passkey hinzu. Das ist bis ${time} möglich.`
      },
      selfFinish: {
        en: 'Finish adding your passkey',
        nl: 'Passkey afmaken',
        de: 'Passkey fertig hinzufügen'
      },
      selfCancel: {
        en: 'Cancel',
        nl: 'Annuleren',
        de: 'Abbrechen'
      },
      selfCancelled: {
        en: 'Adding the passkey was cancelled.',
        nl: 'Het toevoegen van de passkey is geannuleerd.',
        de: 'Das Hinzufügen des Passkeys wurde abgebrochen.'
      },
      /** `reauth_invalid` unknown, or a grant that ran out here: expired, or not started in this browser. */
      selfExpired: {
        en: 'This set-up has expired or was not started in this browser. Sign in again to start over.',
        nl: 'Deze aanvraag is verlopen of is niet in deze browser gestart. Log opnieuw in om opnieuw te beginnen.',
        de: 'Dieser Vorgang ist abgelaufen oder wurde nicht in diesem Browser gestartet. Melde dich erneut an, um neu zu beginnen.'
      },
      /** `reauth_invalid` spent. */
      selfSpent: {
        en: 'That sign-in was already used for a passkey. Sign in again to add another.',
        nl: 'Die inlog is al voor een passkey gebruikt. Log opnieuw in om er nog een toe te voegen.',
        de: 'Diese Anmeldung wurde schon für einen Passkey verwendet. Melde dich erneut an, um einen weiteren hinzuzufügen.'
      },
      /** `reauth_invalid` not_fresh: the sign-in never came back. */
      selfNotFresh: {
        en: 'The sign-in did not complete. Sign in again to add your passkey.',
        nl: 'Het inloggen is niet voltooid. Log opnieuw in om je passkey toe te voegen.',
        de: 'Die Anmeldung wurde nicht abgeschlossen. Melde dich erneut an, um deinen Passkey hinzuzufügen.'
      },
      /** `failed` / `auth_not_fresh`. */
      selfAuthNotFresh: {
        en: 'Your identity provider reused an earlier sign-in. Sign out there, then try again.',
        nl: 'Je identiteitsprovider gebruikte een eerdere inlog opnieuw. Log daar uit en probeer het opnieuw.',
        de: 'Dein Identitätsanbieter hat eine frühere Anmeldung wiederverwendet. Melde dich dort ab und versuche es erneut.'
      },
      /** `failed` / `auth_time_missing`. */
      selfAuthTimeMissing: {
        en: 'Your identity provider does not say when you signed in. Whoever runs the gateway can allow that.',
        nl: 'Je identiteitsprovider geeft niet aan wanneer je inlogde. Wie de gateway beheert kan dat toestaan.',
        de: 'Dein Identitätsanbieter gibt nicht an, wann du dich angemeldet hast. Wer das Gateway betreibt, kann das erlauben.'
      },
      /** `failed` / `user_mismatch`. */
      selfUserMismatch: {
        en: 'You signed in as someone else. Sign in again as yourself.',
        nl: 'Je bent als iemand anders ingelogd. Log opnieuw in als jezelf.',
        de: 'Du hast dich als jemand anderes angemeldet. Melde dich erneut als du selbst an.'
      },
      /** `failed` / `provider_mismatch`. */
      selfProviderMismatch: {
        en: 'You signed in with another sign-in method than the one that started this. Sign in again.',
        nl: 'Je bent met een andere inlogmethode ingelogd dan waarmee dit begon. Log opnieuw in.',
        de: 'Du hast dich mit einer anderen Anmeldemethode angemeldet als der, mit der das begann. Melde dich erneut an.'
      },
      /** `failed` for any other reason. */
      selfFailed: {
        en: 'That sign-in did not count. Sign in again to add your passkey.',
        nl: 'Die inlog telde niet mee. Log opnieuw in om je passkey toe te voegen.',
        de: 'Diese Anmeldung hat nicht gezählt. Melde dich erneut an, um deinen Passkey hinzuzufügen.'
      },
      /** 403 `self_enrol_disabled`. */
      selfDisabled: {
        en: 'Adding a passkey by signing in again is switched off on this gateway. You can still add one with a code.',
        nl: 'Een passkey toevoegen door opnieuw in te loggen staat uit op deze gateway. Met een code kan het nog wel.',
        de: 'Einen Passkey durch erneutes Anmelden hinzuzufügen ist auf diesem Gateway ausgeschaltet. Mit einem Code geht es weiterhin.'
      },
      /** 403 `provider_no_reauth`. */
      selfNoReauth: {
        en: 'Your sign-in provider cannot ask you to sign in again, so a passkey cannot be added this way. You can still add one with a code.',
        nl: 'Je inlogprovider kan niet vragen om opnieuw in te loggen, dus zo kan er geen passkey worden toegevoegd. Met een code kan het nog wel.',
        de: 'Dein Anmeldeanbieter kann dich nicht bitten, dich erneut anzumelden, daher lässt sich auf diesem Weg kein Passkey hinzufügen. Mit einem Code geht es weiterhin.'
      },
      /** The gateway has no `reauth/begin` route. */
      selfNotOffered: {
        en: 'This gateway cannot add a passkey by signing in again. You can add one with a code.',
        nl: 'Deze gateway kan geen passkey toevoegen door opnieuw in te loggen. Met een code kan het wel.',
        de: 'Dieses Gateway kann keinen Passkey durch erneutes Anmelden hinzufügen. Mit einem Code geht es.'
      },
      /** 403 `insecure_binding`. */
      selfInsecure: {
        en: 'Adding a passkey by signing in again needs this page on HTTPS. You can add one with a code.',
        nl: 'Een passkey toevoegen door opnieuw in te loggen vraagt dat deze pagina via HTTPS openstaat. Met een code kan het wel.',
        de: 'Einen Passkey durch erneutes Anmelden hinzuzufügen setzt voraus, dass diese Seite über HTTPS geöffnet ist. Mit einem Code geht es.'
      },
      /** `sessionStorage` would not keep the grant across the sign-in. */
      selfStash: {
        en: 'This browser would not keep what is needed to come back from signing in (private browsing can block that). You can add a passkey with a code.',
        nl: 'Deze browser wil niet bewaren wat nodig is om na het inloggen terug te komen (privé browsen kan dat blokkeren). Met een code kan het wel.',
        de: 'Dieser Browser will nicht speichern, was nötig ist, um nach der Anmeldung zurückzukehren (privates Surfen kann das blockieren). Mit einem Code geht es.'
      },
      /** On a credential that is listed but cannot answer a confirmation yet (the operator's cooling-off). */
      coolingOff: {
        en: ({ time }: { time: string }) => `Not usable yet: ready from ${time}`,
        nl: ({ time }: { time: string }) => `Nog niet bruikbaar: klaar vanaf ${time}`,
        de: ({ time }: { time: string }) => `Noch nicht nutzbar: bereit ab ${time}`
      },
      inviteTitle: {
        en: 'Add another device',
        nl: 'Nog een apparaat toevoegen',
        de: 'Ein weiteres Gerät hinzufügen'
      },
      inviteHelp: {
        en: 'Make a one-time code with a passkey of this browser, and enter it on the other device.',
        nl: 'Maak met een passkey van deze browser een eenmalige code en voer die in op het andere apparaat.',
        de: 'Erstelle mit einem Passkey dieses Browsers einen Einmalcode und gib ihn auf dem anderen Gerät ein.'
      },
      invite: {
        en: 'Make a code',
        nl: 'Code maken',
        de: 'Code erstellen'
      },
      /** Said in the live region when a code was made: the code itself is not read out. */
      inviteReady: {
        en: 'Your code is ready below.',
        nl: 'Je code staat klaar hieronder.',
        de: 'Dein Code steht unten bereit.'
      },
      inviteCodeLabel: {
        en: 'Your code',
        nl: 'Je code',
        de: 'Dein Code'
      },
      copyCode: {
        en: 'Copy the code',
        nl: 'Code kopiëren',
        de: 'Code kopieren'
      },
      codeCopied: {
        en: 'The code was copied.',
        nl: 'De code is gekopieerd.',
        de: 'Der Code wurde kopiert.'
      },
      codeNotCopied: {
        en: 'The code could not be copied. Select it and copy it by hand.',
        nl: 'De code kon niet gekopieerd worden. Selecteer hem en kopieer hem zelf.',
        de: 'Der Code konnte nicht kopiert werden. Markiere ihn und kopiere ihn von Hand.'
      },
      inviteExpires: {
        en: ({ time }: { time: string }) => `It works once, until ${time}.`,
        nl: ({ time }: { time: string }) => `Hij werkt één keer, tot ${time}.`,
        de: ({ time }: { time: string }) => `Er funktioniert einmal, bis ${time}.`
      },
      invalidCode: {
        en: 'That is not an enrolment code. It has 20 letters and digits, in groups of five.',
        nl: 'Dat is geen koppelcode. Die heeft 20 letters en cijfers, in groepjes van vijf.',
        de: 'Das ist kein Registrierungscode. Er hat 20 Buchstaben und Ziffern in Fünfergruppen.'
      },
      codeRefused: {
        en: 'The gateway did not accept that code. It may have been used or expired, or be meant for someone else.',
        nl: 'De gateway accepteerde die code niet. Misschien is hij al gebruikt of verlopen, of is hij voor iemand anders.',
        de: 'Das Gateway hat diesen Code nicht angenommen. Vielleicht wurde er schon benutzt, ist abgelaufen oder für jemand anderen.'
      },
      exists: {
        en: 'This browser already holds a passkey for this gateway.',
        nl: 'Deze browser heeft al een passkey voor deze gateway.',
        de: 'Dieser Browser hat schon einen Passkey für dieses Gateway.'
      },
      cancelled: {
        en: 'The passkey prompt was closed. Nothing changed.',
        nl: 'Het passkey-venster is gesloten. Er is niets veranderd.',
        de: 'Das Passkey-Fenster wurde geschlossen. Es hat sich nichts geändert.'
      },
      notEnrolled: {
        en: 'For that you need a passkey of this browser on this gateway.',
        nl: 'Daarvoor heb je een passkey van deze browser op deze gateway nodig.',
        de: 'Dafür brauchst du einen Passkey dieses Browsers auf diesem Gateway.'
      },
      rateLimited: {
        en: 'Too many tries. Wait a few minutes and try again.',
        nl: 'Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.',
        de: 'Zu viele Versuche. Warte ein paar Minuten und versuch es noch einmal.'
      },
      rateLimitedFor: {
        en: ({ time }: { time: string }) => `Too many tries. Try again in ${time}.`,
        nl: ({ time }: { time: string }) => `Te veel pogingen. Probeer het over ${time} opnieuw.`,
        de: ({ time }: { time: string }) => `Zu viele Versuche. Versuch es in ${time} noch einmal.`
      },
      pinTitle: {
        en: 'This gateway’s identity',
        nl: 'De identiteit van deze gateway',
        de: 'Die Identität dieses Gateways'
      },
      pinHelp: {
        en: 'When you added a passkey here, this browser remembered the identity the gateway gave. If the gateway’s passkey store was reset on purpose, it presents a new one and is refused until this browser forgets the old one. Forget it only if you know the store was reset: a gateway you cannot vouch for could otherwise choose it again.',
        nl: 'Toen je hier een passkey toevoegde, onthield deze browser de identiteit die de gateway gaf. Is de passkey-opslag van de gateway met opzet gewist, dan presenteert hij een nieuwe en wordt hij geweigerd tot deze browser de oude vergeet. Vergeet hem alleen als je weet dat de opslag gewist is: een gateway waar je niet voor kunt instaan zou hem anders opnieuw kunnen kiezen.',
        de: 'Als du hier einen Passkey hinzugefügt hast, hat sich dieser Browser die Identität gemerkt, die das Gateway nannte. Wurde der Passkey-Speicher des Gateways absichtlich zurückgesetzt, meldet es sich mit einer neuen und wird abgelehnt, bis dieser Browser die alte vergisst. Vergiss sie nur, wenn du weißt, dass der Speicher zurückgesetzt wurde: Für ein Gateway, für das du nicht bürgen kannst, könnte sie sich sonst neu wählen.'
      },
      pinForget: {
        en: 'Forget this gateway’s passkey pin',
        nl: 'De passkey-pin van deze gateway vergeten',
        de: 'Den Passkey-Pin dieses Gateways vergessen'
      },
      pinConfirmQuestion: {
        en: 'Forget the identity pinned for this gateway? Passkeys of other gateways stay as they are.',
        nl: 'De vastgezette identiteit van deze gateway vergeten? Passkeys van andere gateways blijven zoals ze zijn.',
        de: 'Die für dieses Gateway gemerkte Identität vergessen? Passkeys anderer Gateways bleiben unverändert.'
      },
      pinConfirm: {
        en: 'Yes, forget it',
        nl: 'Ja, vergeet hem',
        de: 'Ja, vergessen'
      },
      pinCancel: {
        en: 'Keep it',
        nl: 'Bewaren',
        de: 'Behalten'
      },
      pinForgotten: {
        en: 'This browser forgot the gateway’s identity. The next passkey you add pins the one it presents now.',
        nl: 'Deze browser is de identiteit van de gateway vergeten. De volgende passkey die je toevoegt zet degene vast die hij nu presenteert.',
        de: 'Dieser Browser hat die Identität des Gateways vergessen. Der nächste Passkey, den du hinzufügst, merkt sich die, die es jetzt nennt.'
      },
      failed: {
        en: ({ message }: { message: string }) => `That did not work: ${message}`,
        nl: ({ message }: { message: string }) => `Dat is niet gelukt: ${message}`,
        de: ({ message }: { message: string }) => `Das hat nicht geklappt: ${message}`
      }
    }
  },
  secureInput: {
    /** The sheet's heading for a `secret`: who asks, in fixed words (the native apps'). */
    titleSecret: {
      en: ({ name }: { name: string }) => `${name} asks for a secret`,
      nl: ({ name }: { name: string }) => `${name} vraagt om een geheim`,
      de: ({ name }: { name: string }) => `${name} fragt nach einem Geheimnis`
    },
    /** The sheet's heading for a `sudo`. */
    titleSudo: {
      en: ({ name }: { name: string }) => `${name} asks for an administrator password`,
      nl: ({ name }: { name: string }) => `${name} vraagt om een beheerderswachtwoord`,
      de: ({ name }: { name: string }) => `${name} fragt nach einem Administratorpasswort`
    },
    /** The sheet's heading for a `vault.unlock_prompt`. */
    titleVaultUnlock: {
      en: ({ name }: { name: string }) => `${name} asks to unlock a password manager`,
      nl: ({ name }: { name: string }) => `${name} vraagt een wachtwoordmanager te ontgrendelen`,
      de: ({ name }: { name: string }) => `${name} möchte einen Passwortmanager entsperren`
    },
    /** The sheet's heading for a `vault.code`. */
    titleVaultCode: {
      en: ({ name }: { name: string }) => `${name} asks for a one-time code`,
      nl: ({ name }: { name: string }) => `${name} vraagt om een eenmalige code`,
      de: ({ name }: { name: string }) => `${name} fragt nach einem Einmalcode`
    },
    /** The sheet's heading for a `vault.save_login`. */
    titleVaultSaveLogin: {
      en: ({ name }: { name: string }) => `${name} asks to save a login`,
      nl: ({ name }: { name: string }) => `${name} vraagt een login te bewaren`,
      de: ({ name }: { name: string }) => `${name} möchte eine Anmeldung speichern`
    },
    /** Under the heading: which gateway asks (its host). */
    gateway: {
      en: ({ host }: { host: string }) => `On gateway ${host}`,
      nl: ({ host }: { host: string }) => `Op gateway ${host}`,
      de: ({ host }: { host: string }) => `Auf Gateway ${host}`
    },
    /** The label over the request's own words, shown as plain text: they are the bot's, not the app's. */
    quoteLabel: {
      en: 'What the request says',
      nl: 'Wat het verzoek zegt',
      de: 'Was die Anfrage sagt'
    },
    /** The label over the variable a secret is stored under, as the request names it. */
    quoteVariable: {
      en: 'Stored under this name, as the request gives it',
      nl: 'Opgeslagen onder deze naam, zoals het verzoek die geeft',
      de: 'Unter diesem Namen gespeichert, wie die Anfrage ihn angibt'
    },
    /** The label over the password manager's name, as the request gives it. */
    quoteManager: {
      en: 'Password manager, as the request names it',
      nl: 'Wachtwoordmanager, zoals het verzoek die noemt',
      de: 'Passwortmanager, wie die Anfrage ihn nennt'
    },
    /** The label over the website's name, as the request gives it. */
    quoteSite: {
      en: 'Website, as the request names it',
      nl: 'Website, zoals het verzoek die noemt',
      de: 'Website, wie die Anfrage sie nennt'
    },
    /** The label over the website's address, as the request gives it. */
    quoteOrigin: {
      en: 'Address, as the request gives it',
      nl: 'Adres, zoals het verzoek het geeft',
      de: 'Adresse, wie die Anfrage sie angibt'
    },
    /** What a sudo prompt is for. */
    sudoLead: {
      en: 'The bot wants to run this command with administrator rights on the gateway’s computer.',
      nl: 'De bot wil dit commando met beheerdersrechten uitvoeren op de computer van de gateway.',
      de: 'Der Bot möchte diesen Befehl mit Administratorrechten auf dem Rechner des Gateways ausführen.'
    },
    /** A sudo prompt that names no command. */
    sudoNoCommand: {
      en: 'The gateway did not say which command.',
      nl: 'De gateway zegt niet welk commando.',
      de: 'Das Gateway nennt den Befehl nicht.'
    },
    /** What an unlock asks for, in fixed words: the manager's name is the request's and stands in its own box. */
    vaultUnlockLead: {
      en: 'Enter the master password of this password manager.',
      nl: 'Voer het hoofdwachtwoord van deze wachtwoordmanager in.',
      de: 'Gib das Master-Passwort dieses Passwortmanagers ein.'
    },
    /** What a code is for, in fixed words: the site is the request's and stands in its own box. */
    vaultCodeLead: {
      en: 'Enter the code the website asked for.',
      nl: 'Voer de code in waar de website om vroeg.',
      de: 'Gib den Code ein, nach dem die Website gefragt hat.'
    },
    /** What a login is for, in fixed words: the site is the request's and stands in its own box. */
    vaultSaveLoginLead: {
      en: 'Save a login for this website.',
      nl: 'Bewaar een login voor deze website.',
      de: 'Speichere eine Anmeldung für diese Website.'
    },
    /** The field of a secret. */
    fieldValue: {
      en: 'Value',
      nl: 'Waarde',
      de: 'Wert'
    },
    /** The field of a sudo prompt and of a login. */
    fieldPassword: {
      en: 'Password',
      nl: 'Wachtwoord',
      de: 'Passwort'
    },
    /** The field of an unlock. */
    fieldMasterPassword: {
      en: 'Master password',
      nl: 'Hoofdwachtwoord',
      de: 'Master-Passwort'
    },
    /** The field of a one-time code. */
    fieldCode: {
      en: 'Code',
      nl: 'Code',
      de: 'Code'
    },
    /** The first field of a login. */
    fieldUsername: {
      en: 'Username',
      nl: 'Gebruikersnaam',
      de: 'Benutzername'
    },
    /** Who receives a secret, and what becomes of it. */
    receiverStored: {
      en: 'Hermie sends this to the gateway, which stores it for this bot. The bot does not see it. Hermie does not keep it.',
      nl: 'Hermie stuurt dit naar de gateway, die het voor deze bot bewaart. De bot ziet het niet. Hermie bewaart het niet.',
      de: 'Hermie sendet dies an das Gateway, das es für diesen Bot speichert. Der Bot sieht es nicht. Hermie speichert es nicht.'
    },
    /** Who receives a password or a code, and what becomes of it. */
    receiverUsed: {
      en: 'Hermie sends this to the gateway, where the bot uses it. Hermie does not keep it.',
      nl: 'Hermie stuurt dit naar de gateway, waar de bot het gebruikt. Hermie bewaart het niet.',
      de: 'Hermie sendet dies an das Gateway, wo der Bot es nutzt. Hermie speichert es nicht.'
    },
    /** Who receives a login, and what becomes of it. */
    receiverLogin: {
      en: 'Hermie sends this to the gateway, which saves it in the bot’s password vault. Hermie does not keep it.',
      nl: 'Hermie stuurt dit naar de gateway, die het in de wachtwoordkluis van de bot bewaart. Hermie bewaart het niet.',
      de: 'Hermie sendet dies an das Gateway, das es im Passworttresor des Bots speichert. Hermie speichert es nicht.'
    },
    /** Answers a secret, a password or a code. */
    send: {
      en: 'Send',
      nl: 'Versturen',
      de: 'Senden'
    },
    /** Answers a login. */
    save: {
      en: 'Save',
      nl: 'Bewaren',
      de: 'Speichern'
    },
    /** Answers with nothing: the bot is told the person skipped it. */
    skip: {
      en: 'Skip',
      nl: 'Overslaan',
      de: 'Überspringen'
    },
    /** The countdown to the gateway's deadline. */
    expiresIn: {
      en: ({ time }: { time: string }) => `Expires in ${time}`,
      nl: ({ time }: { time: string }) => `Verloopt over ${time}`,
      de: ({ time }: { time: string }) => `Läuft ab in ${time}`
    },
    /** The gateway asks again because an earlier answer never reached it. */
    earlierAnswerLost: {
      en: 'Your earlier answer did not reach the gateway. Enter it again.',
      nl: 'Je eerdere antwoord heeft de gateway niet bereikt. Voer het opnieuw in.',
      de: 'Deine frühere Antwort hat das Gateway nicht erreicht. Gib sie erneut ein.'
    },
    /** The gateway asks again because an earlier Skip never reached it. */
    earlierSkipLost: {
      en: 'You skipped this before, but the gateway did not get that. Skip again, or answer it.',
      nl: 'Je sloeg dit eerder over, maar de gateway heeft dat niet ontvangen. Sla het opnieuw over of beantwoord het.',
      de: 'Du hast das schon übersprungen, aber das Gateway hat es nicht erhalten. Überspring es erneut oder beantworte es.'
    },
    /** Send or Skip was pressed while the connection was down: nothing went out, the field keeps what was typed. */
    offline: {
      en: 'Not connected to the gateway. Nothing was sent; try again once the connection is back.',
      nl: 'Niet verbonden met de gateway. Er is niets verstuurd; probeer het opnieuw zodra de verbinding terug is.',
      de: 'Nicht mit dem Gateway verbunden. Es wurde nichts gesendet; versuch es erneut, sobald die Verbindung wieder da ist.'
    }
  },
  interactive: {
    /** Label over the request's own heading and words: they are the bot's, shown as plain text. */
    quoteLabel: {
      en: 'What the bot says',
      nl: 'Wat de bot zegt',
      de: 'Was der Bot sagt'
    },
    /** Label over the request's extra context, shown monospaced. */
    detailLabel: {
      en: 'More from the bot',
      nl: 'Meer van de bot',
      de: 'Mehr vom Bot'
    },
    /** Label before the name of the person the turn acts for, when the gateway names one. */
    actingFor: {
      en: 'The bot acts for',
      nl: 'De bot handelt namens',
      de: 'Der Bot handelt für'
    },
    /** A press while the connection was down: nothing went out, what was entered stays. */
    offline: {
      en: 'Not connected to the gateway. Nothing was sent; try again once the connection is back.',
      nl: 'Niet verbonden met de gateway. Er is niets verstuurd; probeer het opnieuw zodra de verbinding terug is.',
      de: 'Nicht mit dem Gateway verbunden. Es wurde nichts gesendet; versuch es erneut, sobald die Verbindung wieder da ist.'
    },
    /** Puts the sheet away without answering: the page is usable, and the transcript's record offers Open. */
    later: {
      en: 'Later',
      nl: 'Later',
      de: 'Später'
    },
    /** Tells the bot the person chooses not to share (`4041 declined`): not an answer, and never the default button. */
    dontShare: {
      en: "Don't share",
      nl: 'Niet delen',
      de: 'Nicht teilen'
    },
    /** A press while an earlier answer is still on its way. */
    busy: {
      en: 'An earlier answer is still on its way. Try again in a moment.',
      nl: 'Een eerder antwoord is nog onderweg. Probeer het zo opnieuw.',
      de: 'Eine frühere Antwort ist noch unterwegs. Versuch es gleich noch einmal.'
    },
    /** The call to the gateway failed without its word: the request is still open. */
    failed: {
      en: 'The answer could not be sent. What you entered is still here; try again.',
      nl: 'Het antwoord kon niet worden verstuurd. Wat je invulde staat er nog; probeer het opnieuw.',
      de: 'Die Antwort konnte nicht gesendet werden. Deine Eingaben sind noch da; versuch es erneut.'
    },
    /** The gateway refused the answer for a reason this sheet has no sentence for. */
    refusedOther: {
      en: ({ reason }: { reason: string }) => `The gateway did not accept this answer (${reason}).`,
      nl: ({ reason }: { reason: string }) => `De gateway nam dit antwoord niet aan (${reason}).`,
      de: ({ reason }: { reason: string }) => `Das Gateway hat diese Antwort nicht angenommen (${reason}).`
    },
    /** What a screen reader hears for the visible star beside a required field. */
    required: {
      en: 'required',
      nl: 'verplicht',
      de: 'erforderlich'
    },
    /** Under the form: what the star means. */
    requiredNote: {
      en: '* means required',
      nl: '* betekent verplicht',
      de: '* bedeutet erforderlich'
    },
    form: {
      /** The sheet's heading: fixed words, the bot's own heading is in the quoted box below. */
      title: {
        en: 'A form to fill in',
        nl: 'Een formulier om in te vullen',
        de: 'Ein Formular zum Ausfüllen'
      },
      /** Who receives the answers, and what becomes of them. */
      receiver: {
        en: 'Hermie sends your answers to the gateway, where the bot reads them. Hermie does not keep them.',
        nl: 'Hermie stuurt je antwoorden naar de gateway, waar de bot ze leest. Hermie bewaart ze niet.',
        de: 'Hermie sendet deine Antworten an das Gateway, wo der Bot sie liest. Hermie speichert sie nicht.'
      },
      /** Answers the form. */
      send: {
        en: 'Send answers',
        nl: 'Antwoorden versturen',
        de: 'Antworten senden'
      },
      /** The fields, as a group. */
      fields: {
        en: 'Fields',
        nl: 'Velden',
        de: 'Felder'
      },
      /** Said after a Send that was held back: how many fields need a look. */
      needsAttention: {
        en: ({ count }: { count: number }) =>
          count === 1 ? 'One answer needs attention.' : `${count} answers need attention.`,
        nl: ({ count }: { count: number }) =>
          count === 1 ? 'Eén antwoord vraagt aandacht.' : `${count} antwoorden vragen aandacht.`,
        de: ({ count }: { count: number }) =>
          count === 1 ? 'Eine Antwort braucht Aufmerksamkeit.' : `${count} Antworten brauchen Aufmerksamkeit.`
      },
      /** Under an amount: the currency and how many decimals it takes. */
      amountIn: {
        en: ({ currency, decimals }: { currency: string; decimals: number }) =>
          decimals === 0
            ? `Amount in ${currency}, whole amounts only`
            : `Amount in ${currency}, up to ${decimals} decimals`,
        nl: ({ currency, decimals }: { currency: string; decimals: number }) =>
          decimals === 0
            ? `Bedrag in ${currency}, alleen hele bedragen`
            : `Bedrag in ${currency}, maximaal ${decimals} decimalen`,
        de: ({ currency, decimals }: { currency: string; decimals: number }) =>
          decimals === 0
            ? `Betrag in ${currency}, nur ganze Beträge`
            : `Betrag in ${currency}, höchstens ${decimals} Dezimalstellen`
      },
      /** Under a time or date the request ties to a zone. */
      zoneField: {
        en: ({ zone, offset }: { zone: string; offset: string }) => `Time zone: ${zone} (${offset})`,
        nl: ({ zone, offset }: { zone: string; offset: string }) => `Tijdzone: ${zone} (${offset})`,
        de: ({ zone, offset }: { zone: string; offset: string }) => `Zeitzone: ${zone} (${offset})`
      },
      /** Under a time or date the request leaves to this device's zone. */
      zoneDevice: {
        en: ({ zone, offset }: { zone: string; offset: string }) => `Your time zone: ${zone} (${offset})`,
        nl: ({ zone, offset }: { zone: string; offset: string }) => `Jouw tijdzone: ${zone} (${offset})`,
        de: ({ zone, offset }: { zone: string; offset: string }) => `Deine Zeitzone: ${zone} (${offset})`
      },
      /** Under a datetime: what will be sent for what was entered. */
      sentAs: {
        en: ({ value }: { value: string }) => `Sent as ${value}`,
        nl: ({ value }: { value: string }) => `Verstuurd als ${value}`,
        de: ({ value }: { value: string }) => `Gesendet als ${value}`
      },
      /** The first date of a range. */
      rangeStart: {
        en: 'From',
        nl: 'Van',
        de: 'Von'
      },
      /** The last date of a range. */
      rangeEnd: {
        en: 'To',
        nl: 'Tot',
        de: 'Bis'
      },
      /** Under a long text: how much of its limit is used. */
      characters: {
        en: ({ count, max }: { count: number; max: number }) => `${count} of ${max} characters`,
        nl: ({ count, max }: { count: number; max: number }) => `${count} van ${max} tekens`,
        de: ({ count, max }: { count: number; max: number }) => `${count} von ${max} Zeichen`
      },
      /** Under a multiple choice: how many to pick. */
      pickBetween: {
        en: ({ min, max }: { min: number; max: number }) => `Pick ${min} to ${max}`,
        nl: ({ min, max }: { min: number; max: number }) => `Kies er ${min} tot ${max}`,
        de: ({ min, max }: { min: number; max: number }) => `Wähle ${min} bis ${max}`
      },
      pickAtLeast: {
        en: ({ min }: { min: number }) => `Pick at least ${min}`,
        nl: ({ min }: { min: number }) => `Kies er minstens ${min}`,
        de: ({ min }: { min: number }) => `Wähle mindestens ${min}`
      },
      pickAtMost: {
        en: ({ max }: { max: number }) => `Pick at most ${max}`,
        nl: ({ max }: { max: number }) => `Kies er hoogstens ${max}`,
        de: ({ max }: { max: number }) => `Wähle höchstens ${max}`
      },
      /** Empties a single choice that is not required. */
      clear: {
        en: 'Clear',
        nl: 'Wissen',
        de: 'Leeren'
      },
      /** What is wrong with a field, in the words of the gateway's reasons (`field:<id>:<problem>`). */
      problems: {
        missing: {
          en: 'This is required.',
          nl: 'Dit is verplicht.',
          de: 'Das ist erforderlich.'
        },
        type: {
          en: 'This is not an answer this field takes.',
          nl: 'Dit is geen antwoord dat dit veld aanneemt.',
          de: 'Das ist keine Antwort, die dieses Feld annimmt.'
        },
        formatText: {
          en: 'This has to be on one line.',
          nl: 'Dit moet op één regel staan.',
          de: 'Das muss in einer Zeile stehen.'
        },
        formatNumber: {
          en: 'Enter a number.',
          nl: 'Voer een getal in.',
          de: 'Gib eine Zahl ein.'
        },
        formatAmount: {
          en: ({ currency, decimals }: { currency: string; decimals: number }) =>
            decimals === 0
              ? `Enter a whole amount in ${currency}, without decimals.`
              : `Enter an amount in ${currency} with a point and at most ${decimals} decimals, like 12.5.`,
          nl: ({ currency, decimals }: { currency: string; decimals: number }) =>
            decimals === 0
              ? `Voer een heel bedrag in ${currency} in, zonder decimalen.`
              : `Voer een bedrag in ${currency} in met een punt en maximaal ${decimals} decimalen, zoals 12.5.`,
          de: ({ currency, decimals }: { currency: string; decimals: number }) =>
            decimals === 0
              ? `Gib einen ganzen Betrag in ${currency} ein, ohne Dezimalstellen.`
              : `Gib einen Betrag in ${currency} mit Punkt und höchstens ${decimals} Dezimalstellen ein, etwa 12.5.`
        },
        formatDate: {
          en: 'Enter a real date.',
          nl: 'Voer een echte datum in.',
          de: 'Gib ein echtes Datum ein.'
        },
        formatTime: {
          en: 'Enter a time as hours and minutes.',
          nl: 'Voer een tijd in als uren en minuten.',
          de: 'Gib eine Uhrzeit als Stunden und Minuten ein.'
        },
        formatDatetime: {
          en: 'Enter a real date and time.',
          nl: 'Voer een echte datum en tijd in.',
          de: 'Gib ein echtes Datum mit Uhrzeit ein.'
        },
        formatRange: {
          en: 'Enter a start and an end date, or leave both empty.',
          nl: 'Voer een begin- en een einddatum in, of laat beide leeg.',
          de: 'Gib ein Start- und ein Enddatum ein oder lass beide leer.'
        },
        tooLong: {
          en: ({ max }: { max: number }) => `At most ${max} characters.`,
          nl: ({ max }: { max: number }) => `Maximaal ${max} tekens.`,
          de: ({ max }: { max: number }) => `Höchstens ${max} Zeichen.`
        },
        zone: {
          en: ({ zone }: { zone: string }) => `This browser does not know the time zone ${zone}.`,
          nl: ({ zone }: { zone: string }) => `Deze browser kent de tijdzone ${zone} niet.`,
          de: ({ zone }: { zone: string }) => `Dieser Browser kennt die Zeitzone ${zone} nicht.`
        },
        offset: {
          en: 'That time does not exist in this time zone (the clocks skip it). Pick another time.',
          nl: 'Die tijd bestaat niet in deze tijdzone (de klok slaat hem over). Kies een andere tijd.',
          de: 'Diese Uhrzeit gibt es in dieser Zeitzone nicht (die Uhr überspringt sie). Wähle eine andere.'
        },
        order: {
          en: 'The end is before the start.',
          nl: 'Het einde ligt voor het begin.',
          de: 'Das Ende liegt vor dem Anfang.'
        },
        notAnOption: {
          en: 'Pick one of the options.',
          nl: 'Kies een van de opties.',
          de: 'Wähle eine der Optionen.'
        },
        duplicate: {
          en: 'Each option can be picked only once.',
          nl: 'Elke optie kan maar één keer gekozen worden.',
          de: 'Jede Option lässt sich nur einmal wählen.'
        },
        belowMinValue: {
          en: ({ min }: { min: string }) => `The lowest allowed is ${min}.`,
          nl: ({ min }: { min: string }) => `Het laagste dat mag is ${min}.`,
          de: ({ min }: { min: string }) => `Der niedrigste erlaubte Wert ist ${min}.`
        },
        belowMinWhen: {
          en: ({ min }: { min: string }) => `The earliest allowed is ${min}.`,
          nl: ({ min }: { min: string }) => `Het vroegste dat mag is ${min}.`,
          de: ({ min }: { min: string }) => `Der früheste erlaubte Zeitpunkt ist ${min}.`
        },
        belowMinPlain: {
          en: 'This is too low.',
          nl: 'Dit is te laag.',
          de: 'Das ist zu niedrig.'
        },
        aboveMaxValue: {
          en: ({ max }: { max: string }) => `The highest allowed is ${max}.`,
          nl: ({ max }: { max: string }) => `Het hoogste dat mag is ${max}.`,
          de: ({ max }: { max: string }) => `Der höchste erlaubte Wert ist ${max}.`
        },
        aboveMaxWhen: {
          en: ({ max }: { max: string }) => `The latest allowed is ${max}.`,
          nl: ({ max }: { max: string }) => `Het laatste dat mag is ${max}.`,
          de: ({ max }: { max: string }) => `Der späteste erlaubte Zeitpunkt ist ${max}.`
        },
        aboveMaxPlain: {
          en: 'This is too high.',
          nl: 'Dit is te hoog.',
          de: 'Das ist zu hoch.'
        },
        notInteger: {
          en: 'Enter a whole number.',
          nl: 'Voer een heel getal in.',
          de: 'Gib eine ganze Zahl ein.'
        },
        step: {
          en: ({ step, from }: { step: string; from: string }) => `Use steps of ${step}, counting from ${from}.`,
          nl: ({ step, from }: { step: string; from: string }) => `Gebruik stappen van ${step}, geteld vanaf ${from}.`,
          de: ({ step, from }: { step: string; from: string }) => `Nutze Schritte von ${step}, gezählt ab ${from}.`
        },
        tooFew: {
          en: ({ min }: { min: number }) => `Pick at least ${min}.`,
          nl: ({ min }: { min: number }) => `Kies er minstens ${min}.`,
          de: ({ min }: { min: number }) => `Wähle mindestens ${min}.`
        },
        tooMany: {
          en: ({ max }: { max: number }) => `Pick at most ${max}.`,
          nl: ({ max }: { max: number }) => `Kies er hoogstens ${max}.`,
          de: ({ max }: { max: number }) => `Wähle höchstens ${max}.`
        },
        other: {
          en: 'The gateway did not accept this value.',
          nl: 'De gateway nam deze waarde niet aan.',
          de: 'Das Gateway hat diesen Wert nicht angenommen.'
        }
      }
    },
    file: {
      title: {
        en: 'Files to upload',
        nl: 'Bestanden om te uploaden',
        de: 'Dateien zum Hochladen'
      },
      /** Who receives the files, and what becomes of them. */
      receiver: {
        en: 'Hermie uploads the files to the gateway, where the bot reads them. Hermie does not keep them.',
        nl: 'Hermie uploadt de bestanden naar de gateway, waar de bot ze leest. Hermie bewaart ze niet.',
        de: 'Hermie lädt die Dateien zum Gateway hoch, wo der Bot sie liest. Hermie speichert sie nicht.'
      },
      /** Label over the directory on the gateway the files are saved in. */
      whereLabel: {
        en: 'Saved on the gateway in',
        nl: 'Bewaard op de gateway in',
        de: 'Gespeichert auf dem Gateway in'
      },
      chooseOne: {
        en: 'Choose a file',
        nl: 'Kies een bestand',
        de: 'Datei wählen'
      },
      chooseMany: {
        en: 'Choose files',
        nl: 'Kies bestanden',
        de: 'Dateien wählen'
      },
      /** The bot would like a camera shot: offered next to the picker where a camera is likely. */
      capturePhoto: {
        en: 'Take a photo',
        nl: 'Maak een foto',
        de: 'Foto aufnehmen'
      },
      captureScan: {
        en: 'Scan a document',
        nl: 'Scan een document',
        de: 'Dokument scannen'
      },
      captureAudio: {
        en: 'Record audio',
        nl: 'Neem geluid op',
        de: 'Audio aufnehmen'
      },
      acceptImage: {
        en: 'Pictures only.',
        nl: 'Alleen afbeeldingen.',
        de: 'Nur Bilder.'
      },
      acceptDocument: {
        en: 'Documents only (PDF, text, office files).',
        nl: 'Alleen documenten (PDF, tekst, kantoorbestanden).',
        de: 'Nur Dokumente (PDF, Text, Office-Dateien).'
      },
      acceptAudio: {
        en: 'Audio only.',
        nl: 'Alleen geluid.',
        de: 'Nur Audio.'
      },
      acceptAny: {
        en: 'Any kind of file.',
        nl: 'Elk soort bestand.',
        de: 'Jede Art von Datei.'
      },
      /** The limits of a request for one file. */
      limitOne: {
        en: ({ size }: { size: string }) => `Up to ${size}.`,
        nl: ({ size }: { size: string }) => `Maximaal ${size}.`,
        de: ({ size }: { size: string }) => `Höchstens ${size}.`
      },
      /** The limits of a request for several files. */
      limitMany: {
        en: ({ count, size, total }: { count: number; size: string; total: string }) =>
          `Up to ${count} files, ${size} each and ${total} together.`,
        nl: ({ count, size, total }: { count: number; size: string; total: string }) =>
          `Maximaal ${count} bestanden, ${size} per bestand en ${total} samen.`,
        de: ({ count, size, total }: { count: number; size: string; total: string }) =>
          `Höchstens ${count} Dateien, je ${size} und zusammen ${total}.`
      },
      strip: {
        en: 'Location and camera details are removed from pictures before they go.',
        nl: 'Locatie- en cameragegevens worden uit foto’s gehaald voordat ze verstuurd worden.',
        de: 'Standort- und Kameradaten werden aus Bildern entfernt, bevor sie gesendet werden.'
      },
      /** The list of picked files: its accessible name. */
      picked: {
        en: 'Files to upload',
        nl: 'Te uploaden bestanden',
        de: 'Hochzuladende Dateien'
      },
      /** The accessible name of a picture's preview. */
      previewOf: {
        en: ({ name }: { name: string }) => `Preview of ${name}`,
        nl: ({ name }: { name: string }) => `Voorbeeld van ${name}`,
        de: ({ name }: { name: string }) => `Vorschau von ${name}`
      },
      remove: {
        en: ({ name }: { name: string }) => `Remove ${name}`,
        nl: ({ name }: { name: string }) => `${name} verwijderen`,
        de: ({ name }: { name: string }) => `${name} entfernen`
      },
      removeShort: {
        en: 'Remove',
        nl: 'Verwijderen',
        de: 'Entfernen'
      },
      /** A file that was not added, and why. */
      problemTooLarge: {
        en: ({ name, max }: { name: string; max: string }) => `${name} is larger than ${max} and was not added.`,
        nl: ({ name, max }: { name: string; max: string }) => `${name} is groter dan ${max} en is niet toegevoegd.`,
        de: ({ name, max }: { name: string; max: string }) =>
          `${name} ist größer als ${max} und wurde nicht hinzugefügt.`
      },
      /** A file that was within the limit as picked and is not once it is prepared (a picture re-encoded without its metadata). */
      problemPreparedTooLarge: {
        en: ({ name, max }: { name: string; max: string }) =>
          `${name} is larger than ${max} once it is ready to send. Remove it, or choose a smaller one.`,
        nl: ({ name, max }: { name: string; max: string }) =>
          `${name} is groter dan ${max} zodra het klaar is om te versturen. Verwijder het of kies een kleiner bestand.`,
        de: ({ name, max }: { name: string; max: string }) =>
          `${name} ist größer als ${max}, sobald es zum Senden bereit ist. Entferne die Datei oder wähle eine kleinere.`
      },
      problemWrongKind: {
        en: ({ name }: { name: string }) => `${name} is not the kind of file the bot asked for and was not added.`,
        nl: ({ name }: { name: string }) =>
          `${name} is niet het soort bestand waar de bot om vroeg en is niet toegevoegd.`,
        de: ({ name }: { name: string }) =>
          `${name} ist nicht die Art Datei, um die der Bot bat, und wurde nicht hinzugefügt.`
      },
      problemTooMany: {
        en: ({ max }: { max: number }) =>
          max === 1 ? 'Only one file can be sent.' : `At most ${max} files can be sent.`,
        nl: ({ max }: { max: number }) =>
          max === 1
            ? 'Er kan maar één bestand worden verstuurd.'
            : `Er kunnen maximaal ${max} bestanden worden verstuurd.`,
        de: ({ max }: { max: number }) =>
          max === 1 ? 'Es kann nur eine Datei gesendet werden.' : `Es können höchstens ${max} Dateien gesendet werden.`
      },
      problemTotal: {
        en: ({ max }: { max: string }) => `Together the files may be at most ${max}.`,
        nl: ({ max }: { max: string }) => `Samen mogen de bestanden maximaal ${max} zijn.`,
        de: ({ max }: { max: string }) => `Zusammen dürfen die Dateien höchstens ${max} groß sein.`
      },
      problemStrip: {
        en: ({ name }: { name: string }) =>
          `${name} is a picture this browser cannot clean of location data, so it is not sent. Remove it, or choose a JPEG or a PNG.`,
        nl: ({ name }: { name: string }) =>
          `${name} is een afbeelding waar deze browser de locatiegegevens niet uit kan halen, dus hij wordt niet verstuurd. Verwijder hem, of kies een JPEG of PNG.`,
        de: ({ name }: { name: string }) =>
          `${name} ist ein Bild, aus dem dieser Browser die Standortdaten nicht entfernen kann, daher wird es nicht gesendet. Entferne es oder wähle eine JPEG- oder PNG-Datei.`
      },
      problemPrepare: {
        en: ({ name }: { name: string }) => `${name} could not be prepared for upload.`,
        nl: ({ name }: { name: string }) => `${name} kon niet worden klaargemaakt om te uploaden.`,
        de: ({ name }: { name: string }) => `${name} konnte nicht zum Hochladen vorbereitet werden.`
      },
      problemEmpty: {
        en: ({ name }: { name: string }) => `${name} is empty and was not added.`,
        nl: ({ name }: { name: string }) => `${name} is leeg en is niet toegevoegd.`,
        de: ({ name }: { name: string }) => `${name} ist leer und wurde nicht hinzugefügt.`
      },
      /** Uploads the files and answers. */
      upload: {
        en: 'Upload and send',
        nl: 'Uploaden en versturen',
        de: 'Hochladen und senden'
      },
      preparing: {
        en: 'Preparing the files…',
        nl: 'De bestanden worden klaargemaakt…',
        de: 'Die Dateien werden vorbereitet…'
      },
      uploading: {
        en: ({ current, total, name }: { current: number; total: number; name: string }) =>
          `Uploading ${current} of ${total}: ${name}`,
        nl: ({ current, total, name }: { current: number; total: number; name: string }) =>
          `Uploaden: ${current} van ${total}: ${name}`,
        de: ({ current, total, name }: { current: number; total: number; name: string }) =>
          `Hochladen: ${current} von ${total}: ${name}`
      },
      /** The upload's progress bar: its accessible name. */
      progress: {
        en: 'Upload progress',
        nl: 'Voortgang van het uploaden',
        de: 'Fortschritt des Hochladens'
      },
      sending: {
        en: 'Sending your answer…',
        nl: 'Je antwoord wordt verstuurd…',
        de: 'Deine Antwort wird gesendet…'
      },
      cancel: {
        en: 'Cancel upload',
        nl: 'Uploaden annuleren',
        de: 'Hochladen abbrechen'
      },
      cancelled: {
        en: 'The upload was cancelled. Nothing was sent to the bot.',
        nl: 'Het uploaden is geannuleerd. Er is niets naar de bot gestuurd.',
        de: 'Das Hochladen wurde abgebrochen. Es wurde nichts an den Bot gesendet.'
      },
      /** An upload failed: said before the bot is told. */
      uploadFailed: {
        en: ({ name }: { name: string }) => `${name} could not be uploaded.`,
        nl: ({ name }: { name: string }) => `${name} kon niet worden geüpload.`,
        de: ({ name }: { name: string }) => `${name} konnte nicht hochgeladen werden.`
      },
      failedNote: {
        en: 'You can try again. If you give up, the bot is told the upload failed, which is not an answer.',
        nl: 'Je kunt het opnieuw proberen. Als je opgeeft, hoort de bot dat het uploaden mislukte, en dat is geen antwoord.',
        de: 'Du kannst es erneut versuchen. Wenn du aufgibst, erfährt der Bot, dass das Hochladen fehlschlug, und das ist keine Antwort.'
      },
      retry: {
        en: 'Try again',
        nl: 'Opnieuw proberen',
        de: 'Erneut versuchen'
      },
      giveUp: {
        en: 'Give up',
        nl: 'Opgeven',
        de: 'Aufgeben'
      },
      /** The gateway refused the answer's files (`files:*`, `file:<n>:*`). */
      refusedTooMany: {
        en: ({ max }: { max: number }) => `The gateway takes at most ${max} here. Remove a file and try again.`,
        nl: ({ max }: { max: number }) =>
          `De gateway neemt hier maximaal ${max} aan. Verwijder een bestand en probeer het opnieuw.`,
        de: ({ max }: { max: number }) =>
          `Das Gateway nimmt hier höchstens ${max} an. Entferne eine Datei und versuch es erneut.`
      },
      refusedTotal: {
        en: ({ max }: { max: string }) =>
          `Together the files are more than the gateway takes (${max}). Remove one and try again.`,
        nl: ({ max }: { max: string }) =>
          `Samen zijn de bestanden meer dan de gateway aanneemt (${max}). Verwijder er een en probeer het opnieuw.`,
        de: ({ max }: { max: string }) =>
          `Zusammen sind die Dateien mehr, als das Gateway annimmt (${max}). Entferne eine und versuch es erneut.`
      },
      refusedFile: {
        en: ({ name }: { name: string }) => `The gateway did not accept ${name}. Remove it and try again.`,
        nl: ({ name }: { name: string }) =>
          `De gateway nam ${name} niet aan. Verwijder het bestand en probeer het opnieuw.`,
        de: ({ name }: { name: string }) =>
          `Das Gateway hat ${name} nicht angenommen. Entferne die Datei und versuch es erneut.`
      }
    },
    draft: {
      titleMail: {
        en: 'A mail to review',
        nl: 'Een e-mail om na te kijken',
        de: 'Eine E-Mail zur Prüfung'
      },
      titlePost: {
        en: 'A post to review',
        nl: 'Een bericht om na te kijken',
        de: 'Ein Beitrag zur Prüfung'
      },
      titleMessage: {
        en: 'A message to review',
        nl: 'Een chatbericht om na te kijken',
        de: 'Eine Nachricht zur Prüfung'
      },
      titleDocument: {
        en: 'A document to review',
        nl: 'Een document om na te kijken',
        de: 'Ein Dokument zur Prüfung'
      },
      /** Who receives the decision, and what becomes of it. */
      receiver: {
        en: 'Hermie sends your decision and the text to the gateway, where the bot reads them. Hermie does not keep them.',
        nl: 'Hermie stuurt je besluit en de tekst naar de gateway, waar de bot ze leest. Hermie bewaart ze niet.',
        de: 'Hermie sendet deine Entscheidung und den Text an das Gateway, wo der Bot sie liest. Hermie speichert sie nicht.'
      },
      subject: {
        en: 'Subject',
        nl: 'Onderwerp',
        de: 'Betreff'
      },
      recipients: {
        en: 'Recipients',
        nl: 'Ontvangers',
        de: 'Empfänger'
      },
      /** The draft's text: the label of the editor, and of the read-only text. */
      body: {
        en: 'Draft',
        nl: 'Concept',
        de: 'Entwurf'
      },
      /** Under the editor: what may be done with the text. */
      editable: {
        en: 'You can change the text before you approve it.',
        nl: 'Je kunt de tekst aanpassen voordat je hem goedkeurt.',
        de: 'Du kannst den Text ändern, bevor du ihn freigibst.'
      },
      fixed: {
        en: 'This text cannot be changed here. You can approve or reject it.',
        nl: 'Deze tekst kan hier niet worden aangepast. Je kunt hem goedkeuren of afwijzen.',
        de: 'Dieser Text lässt sich hier nicht ändern. Du kannst ihn freigeben oder ablehnen.'
      },
      approve: {
        en: 'Approve',
        nl: 'Goedkeuren',
        de: 'Freigeben'
      },
      approveChanged: {
        en: 'Approve with changes',
        nl: 'Goedkeuren met wijzigingen',
        de: 'Mit Änderungen freigeben'
      },
      reject: {
        en: 'Reject',
        nl: 'Afwijzen',
        de: 'Ablehnen'
      },
      reset: {
        en: 'Back to the original',
        nl: 'Terug naar het origineel',
        de: 'Zurück zum Original'
      },
      /** The original, shown for comparison once the text was changed. */
      original: {
        en: 'The original from the bot',
        nl: 'Het origineel van de bot',
        de: 'Das Original vom Bot'
      },
      commentLabel: {
        en: 'Reason for rejecting (optional)',
        nl: 'Reden voor afwijzen (optioneel)',
        de: 'Grund für die Ablehnung (optional)'
      },
      commentHint: {
        en: 'The bot is told this when you reject the draft.',
        nl: 'De bot krijgt dit te horen als je het concept afwijst.',
        de: 'Der Bot erfährt das, wenn du den Entwurf ablehnst.'
      },
      /** Characters the eye cannot see, or that turn the text around, found in the text. */
      hidden: {
        en: ({ count }: { count: number }) =>
          count === 1
            ? 'The text holds 1 character that you cannot see or that changes the text direction. The gateway does not take it.'
            : `The text holds ${count} characters that you cannot see or that change the text direction. The gateway does not take them.`,
        nl: ({ count }: { count: number }) =>
          count === 1
            ? 'De tekst bevat 1 teken dat je niet ziet of dat de tekstrichting verandert. De gateway neemt dat niet aan.'
            : `De tekst bevat ${count} tekens die je niet ziet of die de tekstrichting veranderen. De gateway neemt die niet aan.`,
        de: ({ count }: { count: number }) =>
          count === 1
            ? 'Der Text enthält 1 Zeichen, das du nicht siehst oder das die Textrichtung ändert. Das Gateway nimmt es nicht an.'
            : `Der Text enthält ${count} Zeichen, die du nicht siehst oder die die Textrichtung ändern. Das Gateway nimmt sie nicht an.`
      },
      hiddenPreview: {
        en: 'The text with those characters shown',
        nl: 'De tekst met die tekens zichtbaar gemaakt',
        de: 'Der Text mit sichtbar gemachten Zeichen'
      },
      /** A tab or another character the gateway cannot take as it is. */
      notVerbatim: {
        en: 'The text holds characters that cannot be sent as they are (a tab, or one you cannot see). Remove them and try again.',
        nl: 'De tekst bevat tekens die niet zo verstuurd kunnen worden (een tab, of een teken dat je niet ziet). Verwijder ze en probeer het opnieuw.',
        de: 'Der Text enthält Zeichen, die sich nicht so senden lassen (ein Tabulator oder ein unsichtbares Zeichen). Entferne sie und versuch es erneut.'
      },
      /** The gateway's layout rule: spacing that could push part of a text out of view. */
      ruleSpaceRun: {
        en: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Line ${line} has ${size} spaces in a row (at most ${max}), which can push part of the text out of view.`,
        nl: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Regel ${line} heeft ${size} spaties achter elkaar (maximaal ${max}), wat een deel van de tekst uit beeld kan duwen.`,
        de: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Zeile ${line} hat ${size} Leerzeichen hintereinander (höchstens ${max}), was einen Teil des Textes aus dem Blick schieben kann.`
      },
      ruleIndent: {
        en: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Line ${line} is indented ${size} spaces (at most ${max}), which can push part of the text out of view.`,
        nl: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Regel ${line} is ${size} spaties ingesprongen (maximaal ${max}), wat een deel van de tekst uit beeld kan duwen.`,
        de: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Zeile ${line} ist um ${size} Leerzeichen eingerückt (höchstens ${max}), was einen Teil des Textes aus dem Blick schieben kann.`
      },
      ruleBlankLines: {
        en: ({ line, max }: { line: number; max: number }) =>
          `More than ${max} blank lines in a row start at line ${line}, which can push part of the text out of view.`,
        nl: ({ line, max }: { line: number; max: number }) =>
          `Vanaf regel ${line} volgen meer dan ${max} lege regels achter elkaar, wat een deel van de tekst uit beeld kan duwen.`,
        de: ({ line, max }: { line: number; max: number }) =>
          `Ab Zeile ${line} folgen mehr als ${max} Leerzeilen hintereinander, was einen Teil des Textes aus dem Blick schieben kann.`
      },
      ruleLineLength: {
        en: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Line ${line} is ${size} characters long (at most ${max}), which can push part of the text out of view.`,
        nl: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Regel ${line} is ${size} tekens lang (maximaal ${max}), wat een deel van de tekst uit beeld kan duwen.`,
        de: ({ line, size, max }: { line: number; size: number; max: number }) =>
          `Zeile ${line} ist ${size} Zeichen lang (höchstens ${max}), was einen Teil des Textes aus dem Blick schieben kann.`
      },
      ruleMarks: {
        en: 'A character carries too many combining marks, which can hide what is under it.',
        nl: 'Een teken draagt te veel combinerende tekens, wat kan verbergen wat eronder staat.',
        de: 'Ein Zeichen trägt zu viele kombinierende Zeichen, was verbergen kann, was darunter steht.'
      },
      emptyText: {
        en: 'The draft cannot be empty.',
        nl: 'Het concept mag niet leeg zijn.',
        de: 'Der Entwurf darf nicht leer sein.'
      },
      tooLong: {
        en: ({ max }: { max: number }) => `The draft may be at most ${max} characters.`,
        nl: ({ max }: { max: number }) => `Het concept mag maximaal ${max} tekens zijn.`,
        de: ({ max }: { max: number }) => `Der Entwurf darf höchstens ${max} Zeichen lang sein.`
      },
      /** The gateway refused a change to a draft that cannot be changed. */
      refusedEdited: {
        en: 'This draft cannot be changed. Approve it as it is, or reject it.',
        nl: 'Dit concept kan niet worden aangepast. Keur het goed zoals het is, of wijs het af.',
        de: 'Dieser Entwurf lässt sich nicht ändern. Gib ihn so frei, wie er ist, oder lehne ihn ab.'
      }
    },
    /** `review.diff`: the changes to one file, approved or rejected hunk by hunk (`DiffSheet`). */
    diff: {
      title: {
        en: 'Changes to review',
        nl: 'Wijzigingen om na te kijken',
        de: 'Änderungen zur Prüfung'
      },
      /** Who receives the decision, and what becomes of it. */
      receiver: {
        en: 'Hermie sends your decision for each change to the gateway, where the bot reads it. The text of the changes stays with the gateway. Hermie does not keep your decision.',
        nl: 'Hermie stuurt je besluit per wijziging naar de gateway, waar de bot het leest. De tekst van de wijzigingen blijft bij de gateway. Hermie bewaart je besluit niet.',
        de: 'Hermie sendet deine Entscheidung zu jeder Änderung an das Gateway, wo der Bot sie liest. Der Text der Änderungen bleibt beim Gateway. Hermie speichert deine Entscheidung nicht.'
      },
      /** The label over the file's path. */
      file: {
        en: 'File',
        nl: 'Bestand',
        de: 'Datei'
      },
      kindModify: {
        en: 'Changed file',
        nl: 'Gewijzigd bestand',
        de: 'Geänderte Datei'
      },
      kindNew: {
        en: 'New file',
        nl: 'Nieuw bestand',
        de: 'Neue Datei'
      },
      kindDelete: {
        en: 'Delete file',
        nl: 'Bestand verwijderen',
        de: 'Datei löschen'
      },
      /** A rename: the path line then reads "old path → new path". */
      kindRename: {
        en: 'Renamed file',
        nl: 'Hernoemd bestand',
        de: 'Umbenannte Datei'
      },
      /** The heading of one hunk: its place in the list. */
      hunk: {
        en: ({ n, total }: { n: number; total: number }) => `Change ${n} of ${total}`,
        nl: ({ n, total }: { n: number; total: number }) => `Wijziging ${n} van ${total}`,
        de: ({ n, total }: { n: number; total: number }) => `Änderung ${n} von ${total}`
      },
      /** Where the gateway says the hunk lands, whatever its header's line numbers say. */
      anchorStart: {
        en: 'Start of the file',
        nl: 'Begin van het bestand',
        de: 'Anfang der Datei'
      },
      anchorEnd: {
        en: 'End of the file',
        nl: 'Einde van het bestand',
        de: 'Ende der Datei'
      },
      anchorBoth: {
        en: 'Whole file',
        nl: 'Heel het bestand',
        de: 'Ganze Datei'
      },
      /** The scrolling box with a hunk's lines: its accessible name. */
      lines: {
        en: ({ n }: { n: number }) => `Lines of change ${n}`,
        nl: ({ n }: { n: number }) => `Regels van wijziging ${n}`,
        de: ({ n }: { n: number }) => `Zeilen von Änderung ${n}`
      },
      /** What a line is, for a reader that does not see the marker or the colour. */
      lineAdded: {
        en: 'Added line',
        nl: 'Toegevoegde regel',
        de: 'Hinzugefügte Zeile'
      },
      lineRemoved: {
        en: 'Removed line',
        nl: 'Verwijderde regel',
        de: 'Entfernte Zeile'
      },
      lineContext: {
        en: 'Unchanged line',
        nl: 'Ongewijzigde regel',
        de: 'Unveränderte Zeile'
      },
      lineNote: {
        en: 'Note from git',
        nl: 'Opmerking van git',
        de: 'Hinweis von git'
      },
      /** Under a hunk that has a row wider than the view: nothing is cut off, the box scrolls sideways. */
      wide: {
        en: 'Some lines are wider than the view. Scroll sideways to read all of them.',
        nl: 'Sommige regels zijn breder dan het beeld. Scrol opzij om ze helemaal te lezen.',
        de: 'Manche Zeilen sind breiter als die Ansicht. Scrolle zur Seite, um sie ganz zu lesen.'
      },
      approve: {
        en: 'Approve',
        nl: 'Goedkeuren',
        de: 'Freigeben'
      },
      reject: {
        en: 'Reject',
        nl: 'Afwijzen',
        de: 'Ablehnen'
      },
      /** The accessible names of one hunk's two buttons (they start with the visible word). */
      approveHunk: {
        en: ({ n, total }: { n: number; total: number }) => `Approve change ${n} of ${total}`,
        nl: ({ n, total }: { n: number; total: number }) => `Wijziging ${n} van ${total} goedkeuren`,
        de: ({ n, total }: { n: number; total: number }) => `Änderung ${n} von ${total} freigeben`
      },
      rejectHunk: {
        en: ({ n, total }: { n: number; total: number }) => `Reject change ${n} of ${total}`,
        nl: ({ n, total }: { n: number; total: number }) => `Wijziging ${n} van ${total} afwijzen`,
        de: ({ n, total }: { n: number; total: number }) => `Änderung ${n} von ${total} ablehnen`
      },
      approveAll: {
        en: 'Approve all',
        nl: 'Alles goedkeuren',
        de: 'Alle freigeben'
      },
      rejectAll: {
        en: 'Reject all',
        nl: 'Alles afwijzen',
        de: 'Alle ablehnen'
      },
      /** What is decided so far; every hunk must be decided before anything is sent. */
      progress: {
        en: ({ approved, rejected, undecided }: { approved: number; rejected: number; undecided: number }) =>
          `${approved} approved, ${rejected} rejected, ${undecided} undecided`,
        nl: ({ approved, rejected, undecided }: { approved: number; rejected: number; undecided: number }) =>
          `${approved} goedgekeurd, ${rejected} afgewezen, ${undecided} nog niet bepaald`,
        de: ({ approved, rejected, undecided }: { approved: number; rejected: number; undecided: number }) =>
          `${approved} freigegeben, ${rejected} abgelehnt, ${undecided} offen`
      },
      /** Why Send is off. */
      decideAll: {
        en: ({ count }: { count: number }) => `Approve or reject every change before you send (${count} left).`,
        nl: ({ count }: { count: number }) => `Keur elke wijziging goed of af voordat je verstuurt (nog ${count}).`,
        de: ({ count }: { count: number }) =>
          `Gib jede Änderung frei oder lehne sie ab, bevor du sendest (noch ${count}).`
      },
      /** Send, before every change is decided. */
      send: {
        en: 'Send decision',
        nl: 'Besluit versturen',
        de: 'Entscheidung senden'
      },
      /** Send, with at least one change approved: the bot applies those. */
      sendApproved: {
        en: ({ approved, total }: { approved: number; total: number }) =>
          `Apply ${approved} of ${total} ${total === 1 ? 'change' : 'changes'}`,
        nl: ({ approved, total }: { approved: number; total: number }) =>
          `${approved} van ${total} ${total === 1 ? 'wijziging' : 'wijzigingen'} doorvoeren`,
        de: ({ approved, total }: { approved: number; total: number }) =>
          `${approved} von ${total} ${total === 1 ? 'Änderung' : 'Änderungen'} übernehmen`
      },
      /** Send, with every change rejected: nothing is applied. */
      sendRejected: {
        en: 'Reject everything and send',
        nl: 'Alles afwijzen en versturen',
        de: 'Alles ablehnen und senden'
      }
    }
  },
  connections: {
    /** The sheet's heading. */
    title: {
      en: ({ name }: { name: string }) => `${name} wants to connect a service`,
      nl: ({ name }: { name: string }) => `${name} wil een dienst koppelen`,
      de: ({ name }: { name: string }) => `${name} möchte einen Dienst verbinden`
    },
    /** Under the heading: what happens, and who waits. */
    lead: {
      en: ({ host }: { host: string }) =>
        `The bot waits on ${host} until each service below is connected or skipped, or until the time runs out.`,
      nl: ({ host }: { host: string }) =>
        `De bot wacht op ${host} tot elke dienst hieronder gekoppeld of overgeslagen is, of tot de tijd om is.`,
      de: ({ host }: { host: string }) =>
        `Der Bot wartet auf ${host}, bis jeder Dienst unten verbunden oder übersprungen ist oder die Zeit abläuft.`
    },
    /** The list of services: its accessible name. */
    targets: {
      en: 'Services',
      nl: 'Diensten',
      de: 'Dienste'
    },
    /** Opens a service's authorisation page in a new tab. */
    open: {
      en: 'Authorise',
      nl: 'Autoriseren',
      de: 'Autorisieren'
    },
    /** The open button's accessible name: where it goes. */
    openLabel: {
      en: ({ name, host }: { name: string; host: string }) => `Authorise ${name} at ${host} (opens a new tab)`,
      nl: ({ name, host }: { name: string; host: string }) =>
        `${name} autoriseren op ${host} (opent een nieuw tabblad)`,
      de: ({ name, host }: { name: string; host: string }) =>
        `${name} auf ${host} autorisieren (öffnet einen neuen Tab)`
    },
    /** Beside the open button: the host the link goes to. */
    opensAt: {
      en: ({ host }: { host: string }) => `Opens ${host}`,
      nl: ({ host }: { host: string }) => `Opent ${host}`,
      de: ({ host }: { host: string }) => `Öffnet ${host}`
    },
    /** Once the person opened the link from here. */
    opened: {
      en: 'Opened. Finish there; this sheet follows when the service is connected.',
      nl: 'Geopend. Rond het daar af; dit venster volgt zodra de dienst gekoppeld is.',
      de: 'Geöffnet. Schließe es dort ab; dieses Fenster folgt, sobald der Dienst verbunden ist.'
    },
    /** The gateway sent a link the page does not open. */
    linkRefused: {
      en: 'The gateway sent a link Hermie does not open: only https links to a named host are opened.',
      nl: 'De gateway stuurde een link die Hermie niet opent: alleen https-links naar een benoemde host worden geopend.',
      de: 'Das Gateway hat einen Link gesendet, den Hermie nicht öffnet: Nur https-Links zu einem benannten Host werden geöffnet.'
    },
    /** The label over the gateway's own instructions for a row. */
    instructions: {
      en: 'What the gateway says',
      nl: 'Wat de gateway zegt',
      de: 'Was das Gateway sagt'
    },
    /** Skips one service. */
    skip: {
      en: 'Not now',
      nl: 'Niet nu',
      de: 'Nicht jetzt'
    },
    /** The skip button's accessible name. */
    skipLabel: {
      en: ({ name }: { name: string }) => `Not now: ${name}`,
      nl: ({ name }: { name: string }) => `Niet nu: ${name}`,
      de: ({ name }: { name: string }) => `Nicht jetzt: ${name}`
    },
    /** Ends the whole operation now, so the bot stops waiting. */
    cancel: {
      en: 'Stop waiting',
      nl: 'Stop met wachten',
      de: 'Nicht mehr warten'
    },
    /** The countdown to the gateway's deadline. */
    timeLeft: {
      en: ({ time }: { time: string }) => `Time left: ${time}`,
      nl: ({ time }: { time: string }) => `Resterende tijd: ${time}`,
      de: ({ time }: { time: string }) => `Verbleibende Zeit: ${time}`
    },
    /** While an answer goes out. */
    sending: {
      en: 'Sending…',
      nl: 'Versturen…',
      de: 'Wird gesendet…'
    },
    /** An answer that did not go out. */
    failed: {
      en: ({ message }: { message: string }) => `That did not reach the gateway: ${message}`,
      nl: ({ message }: { message: string }) => `Dat kwam niet aan bij de gateway: ${message}`,
      de: ({ message }: { message: string }) => `Das kam nicht beim Gateway an: ${message}`
    },
    state: {
      pending: {
        en: 'Waiting for you',
        nl: 'Wacht op jou',
        de: 'Wartet auf dich'
      },
      initiated: {
        en: 'Started, waiting for the service',
        nl: 'Gestart, wacht op de dienst',
        de: 'Gestartet, wartet auf den Dienst'
      },
      connected: {
        en: 'Connected',
        nl: 'Gekoppeld',
        de: 'Verbunden'
      },
      skipped: {
        en: 'Skipped',
        nl: 'Overgeslagen',
        de: 'Übersprungen'
      },
      failed: {
        en: 'Failed',
        nl: 'Mislukt',
        de: 'Fehlgeschlagen'
      },
      expired: {
        en: 'Expired',
        nl: 'Verlopen',
        de: 'Abgelaufen'
      },
      unavailable: {
        en: 'Not available',
        nl: 'Niet beschikbaar',
        de: 'Nicht verfügbar'
      },
      notConnected: {
        en: 'Not connected',
        nl: 'Niet gekoppeld',
        de: 'Nicht verbunden'
      },
      /** A state this build has no word for: the gateway's own, cleaned. */
      other: {
        en: ({ status }: { status: string }) => `State: ${status}`,
        nl: ({ status }: { status: string }) => `Status: ${status}`,
        de: ({ status }: { status: string }) => `Status: ${status}`
      }
    }
  },
  settings: {
    /** Under a section's title on the Settings home: what is in it. Web wording; the native apps' differ. */
    blurb: {
      account: {
        en: 'Who is signed in in this browser, and how to sign out.',
        nl: 'Wie er in deze browser is ingelogd, en hoe je uitlogt.',
        de: 'Wer in diesem Browser angemeldet ist, und wie du dich abmeldest.'
      },
      gateway: {
        en: 'Which gateway this is, which plugin runs on it and which web client it carries. Read only.',
        nl: 'Welke gateway dit is, welke plugin erop draait en welke webclient hij meelevert. Alleen lezen.',
        de: 'Welches Gateway das ist, welches Plugin darauf läuft und welchen Webclient es mitliefert. Nur lesen.'
      },
      passkeys: {
        en: 'The passkeys that confirm sensitive actions, for this site and for the apps.',
        nl: 'De passkeys die gevoelige handelingen bevestigen, voor deze site en voor de apps.',
        de: 'Die Passkeys, die sensible Aktionen bestätigen, für diese Seite und für die Apps.'
      },
      mcp: {
        en: 'The agents allowed to work on this gateway as you.',
        nl: 'De agents die als jij op deze gateway mogen werken.',
        de: 'Die Agenten, die als du auf diesem Gateway arbeiten dürfen.'
      },
      notifications: {
        en: 'Whether this browser is notified when a bot has news, and what a notification says.',
        nl: 'Of deze browser een melding krijgt als een bot nieuws heeft, en wat een melding zegt.',
        de: 'Ob dieser Browser benachrichtigt wird, wenn ein Bot Neuigkeiten hat, und was eine Benachrichtigung sagt.'
      },
      chats: {
        en: 'What a conversation shows by default, and whether this browser keeps transcripts.',
        nl: 'Wat een gesprek standaard toont, en of deze browser gesprekken bewaart.',
        de: 'Was ein Gespräch standardmäßig zeigt, und ob dieser Browser Verläufe speichert.'
      },
      chatList: {
        en: 'The order of your chats, folders, colours, mutes and the archive.',
        nl: 'De volgorde van je chats, mappen, kleuren, dempingen en het archief.',
        de: 'Die Reihenfolge deiner Chats, Ordner, Farben, Stummschaltungen und das Archiv.'
      },
      appearance: {
        en: 'Light or dark, the accent colour, the language and the text size.',
        nl: 'Licht of donker, de accentkleur, de taal en de tekstgrootte.',
        de: 'Hell oder dunkel, die Akzentfarbe, die Sprache und die Textgröße.'
      },
      about: {
        en: 'Which build this is, and the licences it ships under.',
        nl: 'Welke build dit is, en onder welke licenties hij wordt geleverd.',
        de: 'Welcher Build das ist, und unter welchen Lizenzen er ausgeliefert wird.'
      }
    },
    /** Section titles the catalogue has no word for. */
    title: {
      gateway: {
        en: 'This gateway',
        nl: 'Deze gateway',
        de: 'Dieses Gateway'
      },
      chatList: {
        en: 'Chat list',
        nl: 'Chatlijst',
        de: 'Chatliste'
      }
    },
    /** A line over what follows the person through the gateway, when it is not reaching the gateway. */
    notSynced: {
      local: {
        en: 'The gateway is not taking these settings right now, so they are kept in this browser only. They are sent again when it does.',
        nl: 'De gateway neemt deze instellingen nu niet aan, dus ze worden alleen in deze browser bewaard. Ze worden opnieuw verstuurd zodra dat weer kan.',
        de: 'Das Gateway nimmt diese Einstellungen gerade nicht an, deshalb bleiben sie nur in diesem Browser. Sie werden erneut gesendet, sobald es wieder geht.'
      },
      unavailable: {
        en: 'These settings cannot be sent to the gateway from this page, so they are kept in this browser only. Reload the page to try again.',
        nl: 'Deze instellingen kunnen vanaf deze pagina niet naar de gateway worden gestuurd, dus ze worden alleen in deze browser bewaard. Laad de pagina opnieuw om het nog eens te proberen.',
        de: 'Diese Einstellungen lassen sich von dieser Seite nicht an das Gateway senden, deshalb bleiben sie nur in diesem Browser. Lade die Seite neu, um es erneut zu versuchen.'
      }
    },
    appearance: {
      /** The legend of the accent colour group. */
      tint: {
        en: 'Accent colour',
        nl: 'Accentkleur',
        de: 'Akzentfarbe'
      },
      tintHint: {
        en: 'Used for your messages, buttons, links and the focus ring. It stays in this browser.',
        nl: 'Gebruikt voor je berichten, knoppen, links en de focusrand. Blijft in deze browser.',
        de: 'Wird für deine Nachrichten, Schaltflächen, Links und den Fokusrahmen verwendet. Bleibt in diesem Browser.'
      },
      /** Under the theme group: it belongs to the browser, as the language does. */
      schemeNote: {
        en: 'Light, dark and the language are choices of this browser. They stay when you sign out.',
        nl: 'Licht, donker en de taal zijn keuzes van deze browser. Ze blijven staan als je uitlogt.',
        de: 'Hell, dunkel und die Sprache sind Einstellungen dieses Browsers. Sie bleiben beim Abmelden erhalten.'
      }
    },
    chats: {
      /** The group of the default view: the heading over verbosity, bot-to-bot and thinking. */
      defaultsHeading: {
        en: 'What a new conversation shows',
        nl: 'Wat een nieuw gesprek toont',
        de: 'Was ein neues Gespräch zeigt'
      },
      /** Beside the defaults: where they are kept. */
      defaultsNote: {
        en: 'These are kept in this browser. A conversation with its own setting keeps it.',
        nl: 'Deze worden in deze browser bewaard. Een gesprek met een eigen instelling houdt die.',
        de: 'Diese bleiben in diesem Browser. Ein Gespräch mit eigener Einstellung behält sie.'
      },
      cacheHeading: {
        en: 'Transcripts in this browser',
        nl: 'Gesprekken in deze browser',
        de: 'Verläufe in diesem Browser'
      },
      cacheKeep: {
        en: 'Keep transcripts in this browser',
        nl: 'Gesprekken in deze browser bewaren',
        de: 'Verläufe in diesem Browser speichern'
      },
      cacheHint: {
        en: 'Recent conversations and the list of bots are kept here, so they open at once, before the gateway has answered. Switched off, nothing is kept, and switching off clears what is stored. Signing out clears it too.',
        nl: 'Recente gesprekken en de lijst met bots worden hier bewaard, zodat ze meteen openen, voordat de gateway heeft geantwoord. Uitgezet wordt er niets bewaard, en uitzetten wist wat is opgeslagen. Uitloggen wist het ook.',
        de: 'Aktuelle Gespräche und die Botliste werden hier gespeichert, damit sie sofort öffnen, noch bevor das Gateway geantwortet hat. Ausgeschaltet wird nichts gespeichert, und das Ausschalten löscht das Gespeicherte. Auch das Abmelden löscht es.'
      },
      cacheClear: {
        en: 'Clear now',
        nl: 'Nu wissen',
        de: 'Jetzt löschen'
      },
      cacheCleared: {
        en: 'The stored transcripts were cleared.',
        nl: 'De opgeslagen gesprekken zijn gewist.',
        de: 'Die gespeicherten Verläufe wurden gelöscht.'
      },
      cacheOff: {
        en: 'Transcripts are no longer kept in this browser, and what was stored is cleared.',
        nl: 'Gesprekken worden niet meer in deze browser bewaard, en wat was opgeslagen is gewist.',
        de: 'Verläufe werden nicht mehr in diesem Browser gespeichert, und das Gespeicherte wurde gelöscht.'
      },
      cacheOn: {
        en: 'Transcripts are kept in this browser again.',
        nl: 'Gesprekken worden weer in deze browser bewaard.',
        de: 'Verläufe werden wieder in diesem Browser gespeichert.'
      },
      cacheFailed: {
        en: 'The stored transcripts could not be cleared.',
        nl: 'De opgeslagen gesprekken konden niet worden gewist.',
        de: 'Die gespeicherten Verläufe konnten nicht gelöscht werden.'
      }
    },
    chatList: {
      intro: {
        en: 'Put your chats in order, group them in folders, give them a colour, mute them or move them to the archive. It follows you to every device signed in as you.',
        nl: 'Zet je chats op volgorde, groepeer ze in mappen, geef ze een kleur, demp ze of verplaats ze naar het archief. Het volgt je naar elk apparaat waarop je bent ingelogd.',
        de: 'Bringe deine Chats in Reihenfolge, gruppiere sie in Ordnern, gib ihnen eine Farbe, schalte sie stumm oder verschiebe sie ins Archiv. Es folgt dir auf jedes Gerät, auf dem du angemeldet bist.'
      },
      dragHint: {
        en: 'Drag a row by its handle to reorder it, or use its Move up and Move down buttons.',
        nl: 'Sleep een rij aan het handvat om hem te verplaatsen, of gebruik de knoppen Omhoog en Omlaag.',
        de: 'Ziehe eine Zeile am Griff, um sie zu verschieben, oder nutze die Schaltflächen Nach oben und Nach unten.'
      },
      empty: {
        en: 'There are no chats to arrange yet.',
        nl: 'Er zijn nog geen chats om te ordenen.',
        de: 'Es gibt noch keine Chats zum Anordnen.'
      },
      chatsHeading: {
        en: 'Chats and folders',
        nl: 'Chats en mappen',
        de: 'Chats und Ordner'
      },
      newFolderHeading: {
        en: 'New folder',
        nl: 'Nieuwe map',
        de: 'Neuer Ordner'
      },
      folderCreated: {
        en: ({ name }: { name: string }) => `Folder ${name} created.`,
        nl: ({ name }: { name: string }) => `Map ${name} gemaakt.`,
        de: ({ name }: { name: string }) => `Ordner ${name} angelegt.`
      },
      folderRemoved: {
        en: ({ name }: { name: string }) => `Folder ${name} deleted. Its chats are back in the list.`,
        nl: ({ name }: { name: string }) => `Map ${name} verwijderd. De chats staan weer in de lijst.`,
        de: ({ name }: { name: string }) => `Ordner ${name} gelöscht. Die Chats stehen wieder in der Liste.`
      },
      /** Said politely after a move, so a keyboard reader knows where the row went. */
      position: {
        en: ({ name, index, count }: { name: string; index: number; count: number }) =>
          `${name} is now at position ${index} of ${count}.`,
        nl: ({ name, index, count }: { name: string; index: number; count: number }) =>
          `${name} staat nu op positie ${index} van ${count}.`,
        de: ({ name, index, count }: { name: string; index: number; count: number }) =>
          `${name} steht jetzt an Position ${index} von ${count}.`
      },
      inFolder: {
        en: ({ name, folder }: { name: string; folder: string }) => `${name} is now in ${folder}.`,
        nl: ({ name, folder }: { name: string; folder: string }) => `${name} staat nu in ${folder}.`,
        de: ({ name, folder }: { name: string; folder: string }) => `${name} ist jetzt in ${folder}.`
      },
      archivedNow: {
        en: ({ name }: { name: string }) => `${name} is archived.`,
        nl: ({ name }: { name: string }) => `${name} is gearchiveerd.`,
        de: ({ name }: { name: string }) => `${name} ist archiviert.`
      },
      unarchivedNow: {
        en: ({ name }: { name: string }) => `${name} is out of the archive.`,
        nl: ({ name }: { name: string }) => `${name} is uit het archief gehaald.`,
        de: ({ name }: { name: string }) => `${name} ist aus dem Archiv geholt.`
      },
      /** The mute select: the current state when the chat is muted, kept as the selected line. */
      muteKeep: {
        en: ({ until }: { until: string }) => `Muted until ${until}`,
        nl: ({ until }: { until: string }) => `Gedempt tot ${until}`,
        de: ({ until }: { until: string }) => `Stumm bis ${until}`
      },
      /** Name of the grip that starts a drag; the row it belongs to is named by the list. */
      dragHandle: {
        en: 'Drag to reorder',
        nl: 'Slepen om te verplaatsen',
        de: 'Ziehen zum Verschieben'
      },
      /** The row's own name when the bot has no name the gateway gave. */
      unnamedChat: {
        en: 'Unnamed chat',
        nl: 'Naamloze chat',
        de: 'Chat ohne Namen'
      },
      folderMembers: {
        en: ({ name }: { name: string }) => `Chats in ${name}`,
        nl: ({ name }: { name: string }) => `Chats in ${name}`,
        de: ({ name }: { name: string }) => `Chats in ${name}`
      }
    },
    gateway: {
      address: {
        en: 'Address',
        nl: 'Adres',
        de: 'Adresse'
      },
      hermesVersion: {
        en: 'Hermes version',
        nl: 'Hermes-versie',
        de: 'Hermes-Version'
      },
      modules: {
        en: 'Plugin modules',
        nl: 'Pluginmodules',
        de: 'Plugin-Module'
      },
      noModules: {
        en: 'The plugin lists none.',
        nl: 'De plugin noemt er geen.',
        de: 'Das Plugin nennt keine.'
      },
      moduleState: {
        on: {
          en: 'on',
          nl: 'aan',
          de: 'an'
        },
        off: {
          en: 'off',
          nl: 'uit',
          de: 'aus'
        },
        planned: {
          en: 'planned',
          nl: 'gepland',
          de: 'geplant'
        }
      },
      thisPage: {
        en: 'This page',
        nl: 'Deze pagina',
        de: 'Diese Seite'
      },
      pluginWeb: {
        en: 'Web client in the plugin',
        nl: 'Webclient in de plugin',
        de: 'Webclient im Plugin'
      },
      pluginWebNone: {
        en: 'The plugin does not say which web client it carries.',
        nl: 'De plugin zegt niet welke webclient hij meelevert.',
        de: 'Das Plugin sagt nicht, welchen Webclient es mitliefert.'
      },
      update: {
        en: 'Update',
        nl: 'Update',
        de: 'Update'
      },
      updateUnknown: {
        en: 'No update is known: the plugin does not say which web client it carries.',
        nl: 'Er is geen update bekend: de plugin zegt niet welke webclient hij meelevert.',
        de: 'Kein Update bekannt: Das Plugin sagt nicht, welchen Webclient es mitliefert.'
      },
      updateCurrent: {
        en: 'No update is known: this page is the web client the plugin carries.',
        nl: 'Er is geen update bekend: deze pagina is de webclient die de plugin meelevert.',
        de: 'Kein Update bekannt: Diese Seite ist der Webclient, den das Plugin mitliefert.'
      },
      updateDiffers: {
        en: ({ carried }: { carried: string }) =>
          `The plugin now carries another web client, ${carried}. Reload this page to use it.`,
        nl: ({ carried }: { carried: string }) =>
          `De plugin levert nu een andere webclient mee, ${carried}. Laad deze pagina opnieuw om hem te gebruiken.`,
        de: ({ carried }: { carried: string }) =>
          `Das Plugin liefert jetzt einen anderen Webclient mit, ${carried}. Lade diese Seite neu, um ihn zu verwenden.`
      },
      operatorNote: {
        en: 'Nothing here can be changed. What the operator decides (which modules run, who may use the gateway) is the plugin’s configuration on the gateway itself.',
        nl: 'Hier is niets te wijzigen. Wat de beheerder bepaalt (welke modules draaien, wie de gateway mag gebruiken) is de configuratie van de plugin op de gateway zelf.',
        de: 'Hier lässt sich nichts ändern. Was die Betreiberin oder der Betreiber festlegt (welche Module laufen, wer das Gateway nutzen darf), ist die Konfiguration des Plugins auf dem Gateway selbst.'
      }
    },
    account: {
      userId: {
        en: 'User ID',
        nl: 'Gebruikers-ID',
        de: 'Nutzer-ID'
      },
      signOutQuestion: {
        en: 'Sign out of this gateway in this browser?',
        nl: 'Uitloggen bij deze gateway in deze browser?',
        de: 'In diesem Browser vom Gateway abmelden?'
      },
      signOutHint: {
        en: 'This ends your session on the gateway and removes the transcripts, drafts and chat list arrangement kept in this browser. Your theme, accent colour, language and text size stay.',
        nl: 'Dit beëindigt je sessie op de gateway en verwijdert de gesprekken, concepten en chatlijstindeling die in deze browser staan. Je thema, accentkleur, taal en tekstgrootte blijven staan.',
        de: 'Das beendet deine Sitzung auf dem Gateway und entfernt die Verläufe, Entwürfe und die Chatlisten-Anordnung in diesem Browser. Dein Design, deine Akzentfarbe, Sprache und Textgröße bleiben erhalten.'
      },
      signingOut: {
        en: 'Signing out…',
        nl: 'Uitloggen…',
        de: 'Abmelden…'
      },
      tokenMode: {
        en: 'This gateway has no sign-in, so nobody is signed in here. Hermie uses the session token from the gateway’s own dashboard page, which is as open as that dashboard: whoever can open it there can read the token. Hermie keeps it in this tab’s memory only.',
        nl: 'Deze gateway heeft geen inlog, dus hier is niemand ingelogd. Hermie gebruikt het session token van de eigen dashboardpagina van de gateway, en dat is net zo open als dat dashboard: wie het daar kan openen, kan het token lezen. Hermie houdt het alleen in het geheugen van dit tabblad.',
        de: 'Dieses Gateway hat keine Anmeldung, daher ist hier niemand angemeldet. Hermie verwendet das Session-Token von der eigenen Dashboard-Seite des Gateways, und das ist so offen wie dieses Dashboard: Wer es dort öffnen kann, kann das Token lesen. Hermie behält es nur im Speicher dieses Tabs.'
      },
      forgetQuestion: {
        en: 'Forget the session token in this browser?',
        nl: 'Het session token in deze browser vergeten?',
        de: 'Das Session-Token in diesem Browser vergessen?'
      },
      forgetHint: {
        en: 'This forgets the token and removes the transcripts, drafts and chat list arrangement kept in this browser. Your theme, accent colour, language and text size stay. The gateway is not told: its token keeps working until it restarts.',
        nl: 'Dit vergeet het token en verwijdert de gesprekken, concepten en chatlijstindeling die in deze browser staan. Je thema, accentkleur, taal en tekstgrootte blijven staan. De gateway hoort er niets van: zijn token blijft werken tot hij opnieuw start.',
        de: 'Das vergisst das Token und entfernt die Verläufe, Entwürfe und die Chatlisten-Anordnung in diesem Browser. Dein Design, deine Akzentfarbe, Sprache und Textgröße bleiben erhalten. Das Gateway erfährt davon nichts: Sein Token gilt weiter, bis es neu startet.'
      },
      noGateway: {
        en: 'This page does not know which gateway it belongs to.',
        nl: 'Deze pagina weet niet bij welke gateway hij hoort.',
        de: 'Diese Seite weiß nicht, zu welchem Gateway sie gehört.'
      }
    },
    about: {
      commit: {
        en: 'Commit',
        nl: 'Commit',
        de: 'Commit'
      },
      licencesIntro: {
        en: ({ count }: { count: number }) =>
          count === 1
            ? '1 package ships inside the web client. Open it to read its licence.'
            : `${count} packages ship inside the web client. Open one to read its licence.`,
        nl: ({ count }: { count: number }) =>
          count === 1
            ? 'Er zit 1 pakket in de webclient. Open het om de licentie te lezen.'
            : `Er zitten ${count} pakketten in de webclient. Open er een om de licentie te lezen.`,
        de: ({ count }: { count: number }) =>
          count === 1
            ? 'Im Webclient steckt 1 Paket. Öffne es, um die Lizenz zu lesen.'
            : `Im Webclient stecken ${count} Pakete. Öffne eines, um die Lizenz zu lesen.`
      },
      licencesNone: {
        en: 'This build lists no packages.',
        nl: 'Deze build noemt geen pakketten.',
        de: 'Dieser Build nennt keine Pakete.'
      },
      source: {
        en: 'Source',
        nl: 'Bron',
        de: 'Quelle'
      }
    }
  },
  mcp: {
    settings: {
      intro: {
        en: 'MCP lets an AI agent, such as a coding assistant, work on this gateway as you. You allow each client once; it then acts with your access, and what it sends is marked as sent by an agent. Hermie only shows the endpoint and the clients here and lets you revoke them; the gateway runs the endpoint.',
        nl: 'Met MCP kan een AI-agent, zoals een codeerassistent, als jij op deze gateway werken. Je geeft elke client één keer toestemming; daarna werkt hij met jouw toegang en wat hij verstuurt wordt gemarkeerd als verstuurd door een agent. Hermie toont hier alleen het endpoint en de clients en laat je ze intrekken; de gateway draait het endpoint zelf.',
        de: 'Mit MCP kann ein KI-Agent, etwa ein Coding-Assistent, als du auf diesem Gateway arbeiten. Du erlaubst jeden Client einmal; danach handelt er mit deinem Zugriff, und was er sendet, wird als von einem Agenten gesendet markiert. Hermie zeigt hier nur den Endpunkt und die Clients und lässt dich sie widerrufen; das Gateway betreibt den Endpunkt selbst.'
      },
      loading: {
        en: 'Reading MCP access…',
        nl: 'MCP-toegang wordt gelezen…',
        de: 'MCP-Zugriff wird gelesen…'
      },
      needsSignIn: {
        en: 'MCP access is granted to a person signed in to the gateway. This gateway has no sign-in, so there is nobody to grant it to. Turn on sign-in on the gateway to use it.',
        nl: 'MCP-toegang wordt gegeven aan een persoon die op de gateway is ingelogd. Deze gateway heeft geen inlog, dus er is niemand om het aan te geven. Zet inloggen aan op de gateway om het te gebruiken.',
        de: 'MCP-Zugriff wird einer Person gewährt, die am Gateway angemeldet ist. Dieses Gateway hat keine Anmeldung, also gibt es niemanden, dem er gewährt werden kann. Schalte die Anmeldung am Gateway ein, um ihn zu nutzen.'
      },
      notOffered: {
        en: 'This gateway does not offer MCP.',
        nl: 'Deze gateway biedt geen MCP aan.',
        de: 'Dieses Gateway bietet kein MCP an.'
      },
      signIn: {
        en: 'MCP access is per person, and this gateway does not know who you are. Sign in with your account to see it.',
        nl: 'MCP-toegang is per persoon en deze gateway weet niet wie je bent. Log in met je account om het te zien.',
        de: 'Der MCP-Zugriff gilt pro Person, und dieses Gateway weiß nicht, wer du bist. Melde dich mit deinem Konto an, um ihn zu sehen.'
      },
      failed: {
        en: ({ message }: { message: string }) => `MCP access could not be read: ${message}`,
        nl: ({ message }: { message: string }) => `MCP-toegang kon niet gelezen worden: ${message}`,
        de: ({ message }: { message: string }) => `Der MCP-Zugriff konnte nicht gelesen werden: ${message}`
      },
      retry: {
        en: 'Try again',
        nl: 'Opnieuw proberen',
        de: 'Erneut versuchen'
      },
      on: {
        en: 'MCP is on for this gateway.',
        nl: 'MCP staat aan voor deze gateway.',
        de: 'MCP ist für dieses Gateway eingeschaltet.'
      },
      endpointTitle: {
        en: 'Endpoint address',
        nl: 'Adres van het endpoint',
        de: 'Adresse des Endpunkts'
      },
      commandTitle: {
        en: 'Add it to a client',
        nl: 'Aan een client toevoegen',
        de: 'Zu einem Client hinzufügen'
      },
      commandHelp: {
        en: 'Run this command in a terminal to add the endpoint to an MCP client that supports it. Hermie shows it and copies it; it never runs it.',
        nl: 'Voer dit commando uit in een terminal om het endpoint toe te voegen aan een MCP-client die dat ondersteunt. Hermie toont en kopieert het alleen en voert het nooit uit.',
        de: 'Führe diesen Befehl in einem Terminal aus, um den Endpunkt zu einem MCP-Client hinzuzufügen, der das unterstützt. Hermie zeigt und kopiert ihn nur und führt ihn nie aus.'
      },
      configTitle: {
        en: 'Or use a config file',
        nl: 'Of gebruik een configuratiebestand',
        de: 'Oder eine Konfigurationsdatei verwenden'
      },
      configHelp: {
        en: 'The same entry as JSON, for a client that reads its servers from a file.',
        nl: 'Hetzelfde item als JSON, voor een client die zijn servers uit een bestand leest.',
        de: 'Derselbe Eintrag als JSON, für einen Client, der seine Server aus einer Datei liest.'
      },
      instructionsTitle: {
        en: 'From the gateway',
        nl: 'Van de gateway',
        de: 'Vom Gateway'
      },
      copy: {
        en: 'Copy',
        nl: 'Kopiëren',
        de: 'Kopieren'
      },
      copyEndpoint: {
        en: 'Copy the endpoint address',
        nl: 'Het adres van het endpoint kopiëren',
        de: 'Die Adresse des Endpunkts kopieren'
      },
      copyCommand: {
        en: 'Copy the add command',
        nl: 'Het toevoegcommando kopiëren',
        de: 'Den Hinzufügen-Befehl kopieren'
      },
      copyConfig: {
        en: 'Copy the JSON config',
        nl: 'De JSON-configuratie kopiëren',
        de: 'Die JSON-Konfiguration kopieren'
      },
      copied: {
        en: 'Copied.',
        nl: 'Gekopieerd.',
        de: 'Kopiert.'
      },
      notCopied: {
        en: 'This browser did not allow copying. Select the text and copy it yourself.',
        nl: 'Deze browser stond kopiëren niet toe. Selecteer de tekst en kopieer hem zelf.',
        de: 'Dieser Browser hat das Kopieren nicht erlaubt. Markiere den Text und kopiere ihn selbst.'
      },
      clientsTitle: {
        en: 'Connected clients',
        nl: 'Verbonden clients',
        de: 'Verbundene Clients'
      },
      empty: {
        en: 'No client is connected yet.',
        nl: 'Er is nog geen client verbonden.',
        de: 'Es ist noch kein Client verbunden.'
      },
      unnamed: {
        en: 'Unnamed client',
        nl: 'Client zonder naam',
        de: 'Unbenannter Client'
      },
      allowed: {
        en: ({ date }: { date: string }) => `Allowed ${date}`,
        nl: ({ date }: { date: string }) => `Toegestaan ${date}`,
        de: ({ date }: { date: string }) => `Erlaubt ${date}`
      },
      allowedFrom: {
        en: ({ date, address }: { date: string; address: string }) => `Allowed ${date} from ${address}`,
        nl: ({ date, address }: { date: string; address: string }) => `Toegestaan ${date} vanaf ${address}`,
        de: ({ date, address }: { date: string; address: string }) => `Erlaubt ${date} von ${address}`
      },
      lastUsed: {
        en: ({ date }: { date: string }) => `Last used ${date}`,
        nl: ({ date }: { date: string }) => `Laatst gebruikt ${date}`,
        de: ({ date }: { date: string }) => `Zuletzt verwendet ${date}`
      },
      lastUsedFrom: {
        en: ({ date, address }: { date: string; address: string }) => `Last used ${date} from ${address}`,
        nl: ({ date, address }: { date: string; address: string }) => `Laatst gebruikt ${date} vanaf ${address}`,
        de: ({ date, address }: { date: string; address: string }) => `Zuletzt verwendet ${date} von ${address}`
      },
      neverUsed: {
        en: 'Never used',
        nl: 'Nog niet gebruikt',
        de: 'Noch nie verwendet'
      },
      expires: {
        en: ({ date }: { date: string }) => `Allowed until ${date}`,
        nl: ({ date }: { date: string }) => `Toegestaan tot ${date}`,
        de: ({ date }: { date: string }) => `Erlaubt bis ${date}`
      },
      revoke: {
        en: 'Revoke',
        nl: 'Intrekken',
        de: 'Widerrufen'
      },
      /** The accessible name of a client's Revoke button, and of the confirming one. */
      revokeNamed: {
        en: ({ name }: { name: string }) => `Revoke ${name}`,
        nl: ({ name }: { name: string }) => `${name} intrekken`,
        de: ({ name }: { name: string }) => `${name} widerrufen`
      },
      revokeQuestion: {
        en: ({ name }: { name: string }) =>
          `Revoke ${name}? It stops working at once and has to ask for your permission again.`,
        nl: ({ name }: { name: string }) =>
          `${name} intrekken? Het werkt direct niet meer en moet opnieuw om je toestemming vragen.`,
        de: ({ name }: { name: string }) =>
          `${name} widerrufen? Er funktioniert sofort nicht mehr und muss erneut um deine Erlaubnis bitten.`
      },
      cancel: {
        en: 'Cancel',
        nl: 'Annuleren',
        de: 'Abbrechen'
      },
      revoked: {
        en: ({ name }: { name: string }) => `${name} was revoked.`,
        nl: ({ name }: { name: string }) => `${name} is ingetrokken.`,
        de: ({ name }: { name: string }) => `${name} wurde widerrufen.`
      },
      gone: {
        en: 'That client was already gone. The list is up to date.',
        nl: 'Die client was al weg. De lijst is bijgewerkt.',
        de: 'Dieser Client war schon weg. Die Liste ist aktuell.'
      },
      revokeFailed: {
        en: ({ message }: { message: string }) => `Could not revoke: ${message}`,
        nl: ({ message }: { message: string }) => `Intrekken is niet gelukt: ${message}`,
        de: ({ message }: { message: string }) => `Widerrufen hat nicht geklappt: ${message}`
      },
      /** A write the gateway refused (403 `origin_not_listed`): it does not list this page's address. */
      originNotListed: {
        en: ({ host }: { host: string }) =>
          `The gateway refused this because it does not list ${host} as an address of this page. Ask whoever runs it to add this address.`,
        nl: ({ host }: { host: string }) =>
          `De gateway weigerde dit omdat hij ${host} niet als adres van deze pagina in zijn lijst heeft. Vraag wie hem beheert om dit adres toe te voegen.`,
        de: ({ host }: { host: string }) =>
          `Das Gateway hat das abgelehnt, weil es ${host} nicht als Adresse dieser Seite führt. Bitte die Person, die es betreibt, diese Adresse einzutragen.`
      },
      /** Another tab, the app or the operator allowed a client. */
      changedGranted: {
        en: ({ name }: { name: string }) => `${name} was allowed.`,
        nl: ({ name }: { name: string }) => `${name} is toegestaan.`,
        de: ({ name }: { name: string }) => `${name} wurde erlaubt.`
      },
      /** The gateway said something changed and this build has no word for it. */
      changedOther: {
        en: 'The list of clients changed.',
        nl: 'De lijst met clients is gewijzigd.',
        de: 'Die Liste der Clients hat sich geändert.'
      }
    }
  },
  /** Settings › Notifications (`features/settings/Notifications.tsx`) and the chat options' notification types. */
  push: {
    intro: {
      en: 'The Hermie plugin on your gateway sends a notification to this browser when a bot answers, asks for something or finishes a long task. It travels through your browser’s push service, encrypted so that only this browser can read it.',
      nl: 'De Hermie-plugin op je gateway stuurt deze browser een melding als een bot antwoordt, iets vraagt of een lange taak afrondt. Die gaat via de pushdienst van je browser, versleuteld zodat alleen deze browser hem kan lezen.',
      de: 'Das Hermie-Plugin auf deinem Gateway schickt diesem Browser eine Benachrichtigung, wenn ein Bot antwortet, etwas fragt oder eine lange Aufgabe abschließt. Sie läuft über den Push-Dienst deines Browsers, so verschlüsselt, dass nur dieser Browser sie lesen kann.'
    },
    /** The switch. */
    enable: {
      en: 'Notify this browser',
      nl: 'Meldingen in deze browser',
      de: 'Diesen Browser benachrichtigen'
    },
    /** Why notifications cannot be offered here (`core/push/platform.ts`, `PushUnavailable`). */
    unavailable: {
      insecure: {
        en: 'Browsers only offer notifications to a page served over https. Open this gateway at an https address to turn them on.',
        nl: 'Browsers bieden meldingen alleen aan een pagina die via https wordt geserveerd. Open deze gateway op een https-adres om ze aan te zetten.',
        de: 'Browser bieten Benachrichtigungen nur Seiten an, die über https ausgeliefert werden. Öffne dieses Gateway unter einer https-Adresse, um sie einzuschalten.'
      },
      iosHomeScreen: {
        en: 'On an iPhone or iPad, only a web app on the Home Screen can be notified. In Safari, tap Share, then Add to Home Screen, and open Hermie from there.',
        nl: 'Op een iPhone of iPad kan alleen een webapp op het beginscherm meldingen krijgen. Tik in Safari op Deel, dan op Zet op beginscherm, en open Hermie vanaf daar.',
        de: 'Auf einem iPhone oder iPad kann nur eine Web-App auf dem Home-Bildschirm benachrichtigt werden. Tippe in Safari auf Teilen, dann auf Zum Home-Bildschirm, und öffne Hermie von dort.'
      },
      browser: {
        en: 'This browser does not offer push notifications to web pages.',
        nl: 'Deze browser biedt webpagina’s geen pushmeldingen aan.',
        de: 'Dieser Browser bietet Webseiten keine Push-Benachrichtigungen an.'
      },
      unknown: {
        en: 'Checking what this gateway offers…',
        nl: 'Nagaan wat deze gateway aanbiedt…',
        de: 'Prüfe, was dieses Gateway anbietet…'
      },
      noPlugin: {
        en: 'This gateway has no Hermie plugin, so nothing on it can send a notification.',
        nl: 'Deze gateway heeft geen Hermie-plugin, dus niets op de gateway kan een melding sturen.',
        de: 'Dieses Gateway hat kein Hermie-Plugin, also kann dort nichts eine Benachrichtigung senden.'
      },
      webpushOff: {
        en: 'The Hermie plugin on this gateway does not send browser notifications: its push module is off, or it cannot sign them.',
        nl: 'De Hermie-plugin op deze gateway stuurt geen browsermeldingen: zijn pushmodule staat uit, of hij kan ze niet ondertekenen.',
        de: 'Das Hermie-Plugin auf diesem Gateway sendet keine Browser-Benachrichtigungen: Sein Push-Modul ist aus, oder es kann sie nicht signieren.'
      },
      pluginTooOld: {
        en: 'The Hermie plugin on this gateway is too old to notify this browser: it does not publish the key it signs with. Update the plugin.',
        nl: 'De Hermie-plugin op deze gateway is te oud om deze browser te melden: hij publiceert de sleutel niet waarmee hij ondertekent. Werk de plugin bij.',
        de: 'Das Hermie-Plugin auf diesem Gateway ist zu alt, um diesen Browser zu benachrichtigen: Es veröffentlicht den Schlüssel nicht, mit dem es signiert. Aktualisiere das Plugin.'
      }
    },
    /** What the registration is doing. */
    status: {
      off: {
        en: 'Off. This browser is not registered.',
        nl: 'Uit. Deze browser is niet aangemeld.',
        de: 'Aus. Dieser Browser ist nicht registriert.'
      },
      checking: {
        en: 'Checking this browser’s registration…',
        nl: 'De aanmelding van deze browser wordt gecontroleerd…',
        de: 'Die Registrierung dieses Browsers wird geprüft…'
      },
      registered: {
        en: 'On. This browser is registered with the gateway.',
        nl: 'Aan. Deze browser is aangemeld bij de gateway.',
        de: 'An. Dieser Browser ist beim Gateway registriert.'
      },
      denied: {
        en: 'Notifications are blocked for this site in your browser. Allow them in the site’s settings (next to the address), then turn this on again.',
        nl: 'Meldingen zijn in je browser geblokkeerd voor deze site. Sta ze toe in de instellingen van de site (naast het adres) en zet dit daarna opnieuw aan.',
        de: 'Benachrichtigungen sind in deinem Browser für diese Seite blockiert. Erlaube sie in den Einstellungen der Seite (neben der Adresse) und schalte das dann wieder ein.'
      },
      failed: {
        en: ({ message }: { message: string }) => `Registering this browser failed: ${message}`,
        nl: ({ message }: { message: string }) => `Deze browser aanmelden is mislukt: ${message}`,
        de: ({ message }: { message: string }) => `Die Registrierung dieses Browsers ist fehlgeschlagen: ${message}`
      }
    },
    reregister: {
      en: 'Register again',
      nl: 'Opnieuw aanmelden',
      de: 'Erneut registrieren'
    },
    reregisterHint: {
      en: 'Subscribes this browser again with the gateway’s key and writes a fresh registration. Use it when notifications stopped arriving.',
      nl: 'Meldt deze browser opnieuw aan met de sleutel van de gateway en schrijft een nieuwe aanmelding. Gebruik dit als er geen meldingen meer binnenkomen.',
      de: 'Abonniert diesen Browser erneut mit dem Schlüssel des Gateways und schreibt eine neue Registrierung. Nutze das, wenn keine Benachrichtigungen mehr ankommen.'
    },
    test: {
      en: 'Send a test notification',
      nl: 'Stuur een testmelding',
      de: 'Testbenachrichtigung senden'
    },
    /** What the plugin's test route answered. */
    testResult: {
      sent: {
        en: 'Sent. It should appear in a moment.',
        nl: 'Verstuurd. Hij zou zo moeten verschijnen.',
        de: 'Gesendet. Sie sollte gleich erscheinen.'
      },
      refused: {
        en: ({ outcome }: { outcome: string }) => `The push service did not take it (${outcome}).`,
        nl: ({ outcome }: { outcome: string }) => `De pushdienst heeft hem niet aangenomen (${outcome}).`,
        de: ({ outcome }: { outcome: string }) => `Der Push-Dienst hat sie nicht angenommen (${outcome}).`
      },
      notRegistered: {
        en: 'The gateway has no registration for this browser yet. Wait a moment and try again.',
        nl: 'De gateway heeft nog geen aanmelding van deze browser. Wacht even en probeer het opnieuw.',
        de: 'Das Gateway hat noch keine Registrierung dieses Browsers. Warte kurz und versuche es erneut.'
      },
      busy: {
        en: ({ seconds }: { seconds: number }) => `Wait ${seconds} seconds before sending another.`,
        nl: ({ seconds }: { seconds: number }) => `Wacht ${seconds} seconden voordat je er nog een stuurt.`,
        de: ({ seconds }: { seconds: number }) => `Warte ${seconds} Sekunden, bevor du eine weitere sendest.`
      },
      failed: {
        en: ({ status }: { status: number }) => `The gateway could not send it (HTTP ${status}).`,
        nl: ({ status }: { status: number }) => `De gateway kon hem niet versturen (HTTP ${status}).`,
        de: ({ status }: { status: number }) => `Das Gateway konnte sie nicht senden (HTTP ${status}).`
      },
      unreachable: {
        en: 'The gateway could not be reached.',
        nl: 'De gateway was niet bereikbaar.',
        de: 'Das Gateway war nicht erreichbar.'
      }
    }
  },
  /**
   * Settings, Voice (`features/settings/Voice.tsx`): what only the browser has to say. The rate, the language and
   * the switches are the catalogue's (`chat.voice`), shared with the apps.
   */
  voice: {
    reading: {
      en: 'Reading aloud',
      nl: 'Voorlezen',
      de: 'Vorlesen'
    },
    readingHint: {
      en: 'Replies are read by this browser’s own voices, on this device. Nothing is sent anywhere.',
      nl: 'Antwoorden worden voorgelezen door de eigen stemmen van deze browser, op dit apparaat. Er wordt niets verstuurd.',
      de: 'Antworten werden von den eigenen Stimmen dieses Browsers auf diesem Gerät vorgelesen. Es wird nichts gesendet.'
    },
    dictation: {
      en: 'Dictation',
      nl: 'Dicteren',
      de: 'Diktieren'
    },
    dictationHint: {
      en: 'A browser cannot list the languages it recognises, so these are the ones Hermie is written in; the browser’s own language is the default.',
      nl: 'Een browser kan de talen die hij herkent niet opsommen, dus dit zijn de talen waarin Hermie is geschreven; de eigen taal van de browser is de standaard.',
      de: 'Ein Browser kann die Sprachen, die er erkennt, nicht auflisten, deshalb sind das die Sprachen, in denen Hermie geschrieben ist; die eigene Sprache des Browsers ist der Standard.'
    },
    privacy: {
      en: 'Dictation is done by your browser’s own speech service, which sends the audio to the browser’s maker (Google for Chrome, Apple for Safari) to be turned into text, and Hermie cannot change that. The Hermie apps for iPhone, iPad and Mac do it on the device and never send it anywhere. What you dictate waits in the message field until you send it.',
      nl: 'Dicteren wordt gedaan door de eigen spraakdienst van je browser, die de audio naar de maker van de browser stuurt (Google voor Chrome, Apple voor Safari) om er tekst van te maken, en Hermie kan dat niet veranderen. De Hermie-apps voor iPhone, iPad en Mac doen het op het apparaat en sturen het nergens heen. Wat je dicteert wacht in het berichtveld tot je het verstuurt.',
      de: 'Das Diktieren übernimmt der eigene Sprachdienst deines Browsers, der das Audio an den Hersteller des Browsers sendet (Google bei Chrome, Apple bei Safari), damit Text daraus wird, und Hermie kann das nicht ändern. Die Hermie-Apps für iPhone, iPad und Mac erledigen das auf dem Gerät und senden es nirgendwohin. Was du diktierst, wartet im Nachrichtenfeld, bis du es sendest.'
    },
    unavailable: {
      en: 'This browser can neither read aloud nor take dictation.',
      nl: 'Deze browser kan niet voorlezen en niet dicteren.',
      de: 'Dieser Browser kann weder vorlesen noch Diktat annehmen.'
    }
  }
} as const satisfies Branch

export type SheetStrings = Translated<typeof SHEET_STRINGS_SOURCE>

/** The sheets' web-only strings in the language the reader is using. */
export const sheetStrings = localise(SHEET_STRINGS_SOURCE) as unknown as SheetStrings
