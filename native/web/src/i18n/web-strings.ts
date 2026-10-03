/**
 * Strings only the web client has, in all three languages.
 *
 * Anything both the Apple apps and the web client say lives in the Expo
 * catalogue and arrives through `npm run i18n` (`src/generated/strings.ts`);
 * this table is for what a browser alone needs: refusing to run in a frame, a
 * wrong base path, the language row that follows the browser instead of the
 * device. Same glossary and the same register as the catalogue (docs/i18n.md):
 * informal `je` and `du`, product words left in English.
 *
 * A leaf is written once with its three languages, so a missing translation is a
 * compile error, and `web-strings.test.ts` adds what the type cannot say (no
 * empty text, no silent copy of the English, placeholders that agree).
 *
 *   webStrings.frameGuard.refused                   a string
 *   webStrings.basePath.misconfigured({ expected }) a function
 *
 * Reads resolve when they are made, in the active language, exactly like the
 * generated tree.
 */
import { activeLocale, type Locale } from './active-locale'

/** One string in every language. */
export interface Leaf<V> {
  readonly en: V
  readonly nl: V
  readonly de: V
}

// `never` as the argument type lets every function leaf be stored; the typed
// call comes from `Translated` below, which reads the real parameter type.
type AnyLeaf = Leaf<string> | Leaf<(args: never) => string>

export interface Branch {
  readonly [key: string]: AnyLeaf | Branch
}

/** The strings, as written: every leaf in en, nl and de. */
export const WEB_STRINGS_SOURCE = {
  frameGuard: {
    /** Shown instead of the client when it finds itself inside a frame. */
    refused: {
      en: 'Hermie does not run inside a frame. Open it in a tab of its own.',
      nl: 'Hermie draait niet in een frame. Open het in een eigen tabblad.',
      de: 'Hermie läuft nicht in einem Frame. Öffne es in einem eigenen Tab.'
    }
  },
  basePath: {
    /** Shown when the page is not served from the path the client derives its gateway from. */
    misconfigured: {
      en: ({ expected }: { expected: string }) =>
        `This page is not served from the path Hermie expects. Open it at ${expected}.`,
      nl: ({ expected }: { expected: string }) =>
        `Deze pagina wordt niet geserveerd op het pad dat Hermie verwacht. Open hem op ${expected}.`,
      de: ({ expected }: { expected: string }) =>
        `Diese Seite wird nicht unter dem Pfad ausgeliefert, den Hermie erwartet. Öffne sie unter ${expected}.`
    }
  },
  boot: {
    /**
     * Shown when the gateway's address answered 401 or 403 where the gateway itself would not
     * (an access proxy, a firewall, an origin check). A person signing in again would only come back here.
     */
    refusedInFront: {
      en: ({ status }: { status: number }) =>
        `Something between this page and the gateway answered HTTP ${status} instead of the gateway. Signing in again will not help: ask whoever runs the proxy or firewall to let /api, /auth and /login through.`,
      nl: ({ status }: { status: number }) =>
        `Iets tussen deze pagina en de gateway antwoordde met HTTP ${status} in plaats van de gateway. Opnieuw inloggen helpt niet: vraag wie de proxy of firewall beheert om /api, /auth en /login door te laten.`,
      de: ({ status }: { status: number }) =>
        `Etwas zwischen dieser Seite und dem Gateway hat mit HTTP ${status} geantwortet statt des Gateways. Erneutes Anmelden hilft nicht: Bitte die Person, die Proxy oder Firewall betreibt, /api, /auth und /login durchzulassen.`
    }
  },
  markdown: {
    /** The code block's copy button: its label and its accessible name. */
    copyCode: {
      en: 'Copy code',
      nl: 'Code kopiëren',
      de: 'Code kopieren'
    },
    /** Announced, and shown beside the button, once the code is on the clipboard. */
    copied: {
      en: 'Copied',
      nl: 'Gekopieerd',
      de: 'Kopiert'
    },
    /** When the browser refuses the copy (no secure context, no permission). */
    copyFailed: {
      en: 'Could not copy',
      nl: 'Kopiëren is niet gelukt',
      de: 'Kopieren fehlgeschlagen'
    },
    /** The name of the checkbox on a finished task-list item. */
    taskDone: {
      en: 'Done',
      nl: 'Klaar',
      de: 'Erledigt'
    },
    /** The name of the checkbox on an open task-list item. */
    taskOpen: {
      en: 'Not done',
      nl: 'Niet klaar',
      de: 'Offen'
    }
  },
  shell: {
    /** The first link on the page: jumps past the chat list to the main pane. */
    skipToContent: {
      en: 'Skip to content',
      nl: 'Naar de inhoud',
      de: 'Zum Inhalt springen'
    },
    /** The back affordance of the one-pane layout, which returns to the chat list. */
    backToChats: {
      en: 'Back to chats',
      nl: 'Terug naar chats',
      de: 'Zurück zu den Chats'
    },
    /** A hint under the chat list when the gateway has no Hermie plugin; the client works without it. */
    noPlugin: {
      en: 'This gateway has no Hermie plugin. Chats work, but notifications need it.',
      nl: 'Deze gateway heeft geen Hermie-plugin. Chats werken, maar voor meldingen is de plugin nodig.',
      de: 'Dieses Gateway hat kein Hermie-Plugin. Chats funktionieren, aber Benachrichtigungen brauchen es.'
    },
    /** The main pane's body on a settings route until Settings exists. */
    settingsSoon: {
      en: 'Settings are still being built.',
      nl: 'Instellingen komen er nog aan.',
      de: 'Die Einstellungen folgen noch.'
    },
    /** The stamp on a chat row whose last message is under a minute old. */
    now: {
      en: 'Now',
      nl: 'Nu',
      de: 'Jetzt'
    },
    /** Shown instead of the app when the operator has switched the bundled client off on this gateway. */
    switchedOff: {
      en: 'The web client is switched off on this gateway. Ask whoever runs it to switch it on.',
      nl: 'De webclient staat uit op deze gateway. Vraag degene die hem beheert om hem aan te zetten.',
      de: 'Der Webclient ist auf diesem Gateway ausgeschaltet. Bitte die Person, die es betreibt, ihn einzuschalten.'
    },
    /** The client's own version in the sidebar footer: `Version 0.2.0 (abc1234)`. */
    version: {
      en: ({ version }: { version: string }) => `Version ${version}`,
      nl: ({ version }: { version: string }) => `Versie ${version}`,
      de: ({ version }: { version: string }) => `Version ${version}`
    }
  },
  chat: {
    /** The accessible name of the transcript region (`role="log"`). */
    transcriptLabel: {
      en: ({ name }: { name: string }) => `Conversation with ${name}`,
      nl: ({ name }: { name: string }) => `Gesprek met ${name}`,
      de: ({ name }: { name: string }) => `Unterhaltung mit ${name}`
    },
    /** Announced politely when a reply has finished: who, and the start of what they said. */
    replied: {
      en: ({ name, text }: { name: string; text: string }) => `${name} replied: ${text}`,
      nl: ({ name, text }: { name: string; text: string }) => `${name} antwoordde: ${text}`,
      de: ({ name, text }: { name: string; text: string }) => `${name} hat geantwortet: ${text}`
    },
    /** Shown instead of a conversation whose bot the gateway does not list. */
    notOnGateway: {
      en: 'This chat is not on this gateway.',
      nl: 'Deze chat staat niet op deze gateway.',
      de: 'Dieser Chat ist nicht auf diesem Gateway.'
    },
    /** Above a past conversation or a branch, which can be read and not answered. */
    readOnly: {
      en: 'You are reading an earlier conversation. It cannot be answered.',
      nl: 'Je leest een eerder gesprek. Daar kun je niet meer op antwoorden.',
      de: 'Du liest eine frühere Unterhaltung. Darauf lässt sich nicht mehr antworten.'
    },
    /** The name of the list of files a message carries. */
    attachments: {
      en: 'Attachments',
      nl: 'Bijlagen',
      de: 'Anhänge'
    },
    /** The name of a message for assistive technology: who said it, and when. */
    messageFrom: {
      en: ({ name, time }: { name: string; time: string }) => `${name}, ${time}`,
      nl: ({ name, time }: { name: string; time: string }) => `${name}, ${time}`,
      de: ({ name, time }: { name: string; time: string }) => `${name}, ${time}`
    },
    /** The bot is writing a tool call (`tool.generating`) and has named the tool, before the call exists. */
    preparingTool: {
      en: ({ name }: { name: string }) => `Preparing ${name}…`,
      nl: ({ name }: { name: string }) => `${name} wordt voorbereid…`,
      de: ({ name }: { name: string }) => `${name} wird vorbereitet…`
    },
    /** The name of the bot's task list over the composer (`todo.updated`). */
    todoTitle: {
      en: 'Tasks',
      nl: 'Taken',
      de: 'Aufgaben'
    },
    /** Beside the title: how far the list is. */
    todoProgress: {
      en: ({ done, total }: { done: number; total: number }) => `${done} of ${total} done`,
      nl: ({ done, total }: { done: number; total: number }) => `${done} van ${total} klaar`,
      de: ({ done, total }: { done: number; total: number }) => `${done} von ${total} erledigt`
    },
    /** What each task's mark means, said to assistive technology. */
    todoStatus: {
      pending: {
        en: 'To do',
        nl: 'Te doen',
        de: 'Offen'
      },
      in_progress: {
        en: 'In progress',
        nl: 'Bezig',
        de: 'In Arbeit'
      },
      completed: {
        en: 'Done',
        nl: 'Klaar',
        de: 'Erledigt'
      },
      cancelled: {
        en: 'Cancelled',
        nl: 'Geannuleerd',
        de: 'Abgebrochen'
      }
    }
  },
  sessions: {
    /** The button on a bot's Conversations page that puts the current conversation away and starts a new one (`/new`). */
    newConversation: {
      en: 'New conversation',
      nl: 'Nieuw gesprek',
      de: 'Neue Unterhaltung'
    },
    /** Asked before a new conversation starts: the group chat is everybody's, so this puts it away for everybody. */
    newConfirmBody: {
      en: 'The current conversation moves to Past conversations and a new one starts. Everyone on this gateway shares it.',
      nl: 'Het huidige gesprek gaat naar Eerdere gesprekken en er begint een nieuw gesprek. Iedereen op deze gateway deelt het.',
      de: 'Die aktuelle Unterhaltung wird zu den früheren Unterhaltungen gelegt und eine neue beginnt. Alle auf diesem Gateway teilen sie.'
    },
    /** The button that confirms it. */
    newConfirm: {
      en: 'Start a new conversation',
      nl: 'Nieuw gesprek starten',
      de: 'Neue Unterhaltung beginnen'
    },
    /** Shown when the new conversation could not be started. */
    newFailed: {
      en: ({ message }: { message: string }) => `The new conversation was not started: ${message}`,
      nl: ({ message }: { message: string }) => `Het nieuwe gesprek is niet gestart: ${message}`,
      de: ({ message }: { message: string }) => `Die neue Unterhaltung wurde nicht begonnen: ${message}`
    },
    /** Said once a conversation has been renamed. */
    renamed: {
      en: 'The conversation has a new name.',
      nl: 'Het gesprek heeft een nieuwe naam.',
      de: 'Die Unterhaltung hat einen neuen Namen.'
    },
    /** Said once a conversation has been deleted. */
    deleted: {
      en: 'The conversation was deleted.',
      nl: 'Het gesprek is verwijderd.',
      de: 'Die Unterhaltung wurde gelöscht.'
    },
    /** Said once a past conversation or a branch has become the Bot Chat. */
    adopted: {
      en: 'That conversation is the Bot Chat now.',
      nl: 'Dat gesprek is nu de Bot Chat.',
      de: 'Diese Unterhaltung ist jetzt der Bot Chat.'
    },
    /** A rename, delete or swap the gateway refused, with its reason. */
    actionFailed: {
      en: ({ message }: { message: string }) => `That did not work: ${message}`,
      nl: ({ message }: { message: string }) => `Dat lukte niet: ${message}`,
      de: ({ message }: { message: string }) => `Das hat nicht geklappt: ${message}`
    },
    /** Above a past conversation or a branch: the way back to the bot's chat. */
    backToChat: {
      en: 'Back to the chat',
      nl: 'Terug naar de chat',
      de: 'Zurück zum Chat'
    },
    /** The accessible name of the conversation's group of actions, with its title. */
    actionsFor: {
      en: ({ name }: { name: string }) => `Actions for ${name}`,
      nl: ({ name }: { name: string }) => `Acties voor ${name}`,
      de: ({ name }: { name: string }) => `Aktionen für ${name}`
    }
  },
  search: {
    /** Announced when a chat opened from a search hit has scrolled to the row with the words in it. */
    found: {
      en: ({ query }: { query: string }) => `Found “${query}” in this chat.`,
      nl: ({ query }: { query: string }) => `“${query}” gevonden in deze chat.`,
      de: ({ query }: { query: string }) => `„${query}“ in diesem Chat gefunden.`
    }
  },
  composer: {
    /** Under the field when a send was refused: the words are back in the field. */
    sendFailed: {
      en: ({ message }: { message: string }) => `The message was not sent: ${message}`,
      nl: ({ message }: { message: string }) => `Het bericht is niet verstuurd: ${message}`,
      de: ({ message }: { message: string }) => `Die Nachricht wurde nicht gesendet: ${message}`
    },
    /** The name of the list of messages waiting behind the running reply. */
    queueLabel: {
      en: 'Messages waiting to be sent',
      nl: 'Berichten die wachten om verstuurd te worden',
      de: 'Nachrichten, die auf den Versand warten'
    },
    /** Under the field when a queued message could not be handed to the running reply. */
    steerFailed: {
      en: ({ message }: { message: string }) => `Could not steer the reply: ${message}`,
      nl: ({ message }: { message: string }) => `Het antwoord bijsturen is niet gelukt: ${message}`,
      de: ({ message }: { message: string }) => `Die Antwort ließ sich nicht lenken: ${message}`
    },
    /** The name of the list of commands the gateway offers for what is typed. */
    commandsLabel: {
      en: 'Commands',
      nl: 'Commando’s',
      de: 'Befehle'
    }
  },
  attachments: {
    /** The name of the strip of attachments staged for the next message. */
    trayLabel: {
      en: 'Attachments for the next message',
      nl: 'Bijlagen voor het volgende bericht',
      de: 'Anhänge für die nächste Nachricht'
    },
    /** Said politely once files were added to the tray, by the picker, a drop or a paste. */
    added: {
      en: ({ count }: { count: number }) => (count === 1 ? '1 attachment added' : `${count} attachments added`),
      nl: ({ count }: { count: number }) => (count === 1 ? '1 bijlage toegevoegd' : `${count} bijlagen toegevoegd`),
      de: ({ count }: { count: number }) => (count === 1 ? '1 Anhang hinzugefügt' : `${count} Anhänge hinzugefügt`)
    },
    /** On an image's chip while its bytes are read. */
    preparing: {
      en: 'Preparing…',
      nl: 'Voorbereiden…',
      de: 'Wird vorbereitet…'
    },
    /** On a file's chip while it goes to the gateway. There is no percentage: the browser reports none. */
    uploading: {
      en: 'Uploading…',
      nl: 'Uploaden…',
      de: 'Wird hochgeladen…'
    },
    /** On a chip whose file the browser could not read. */
    unreadable: {
      en: 'This file could not be read.',
      nl: 'Dit bestand kon niet worden gelezen.',
      de: 'Diese Datei ließ sich nicht lesen.'
    },
    /** On a chip the gateway refused, with the gateway's own reason. */
    refused: {
      en: ({ detail }: { detail: string }) => `The gateway refused it: ${detail}`,
      nl: ({ detail }: { detail: string }) => `De gateway weigerde het: ${detail}`,
      de: ({ detail }: { detail: string }) => `Das Gateway hat es abgelehnt: ${detail}`
    },
    /** On a chip whose upload did not complete, with what went wrong. */
    failed: {
      en: ({ message }: { message: string }) => `Upload failed: ${message}`,
      nl: ({ message }: { message: string }) => `Upload mislukt: ${message}`,
      de: ({ message }: { message: string }) => `Hochladen fehlgeschlagen: ${message}`
    },
    /** Said politely when a chip did not become ready: its name, then why. */
    problemAnnounced: {
      en: ({ name, problem }: { name: string; problem: string }) => `${name}: ${problem}`,
      nl: ({ name, problem }: { name: string; problem: string }) => `${name}: ${problem}`,
      de: ({ name, problem }: { name: string; problem: string }) => `${name}: ${problem}`
    },
    /** The accessible name of a chip's cancel button. */
    cancelNamed: {
      en: ({ name }: { name: string }) => `Cancel the upload of ${name}`,
      nl: ({ name }: { name: string }) => `Upload van ${name} annuleren`,
      de: ({ name }: { name: string }) => `Hochladen von ${name} abbrechen`
    },
    /** The visible text of a failed chip's retry button. */
    retry: {
      en: 'Try again',
      nl: 'Opnieuw',
      de: 'Erneut'
    },
    /** The accessible name of a failed chip's retry button. */
    retryNamed: {
      en: ({ name }: { name: string }) => `Try ${name} again`,
      nl: ({ name }: { name: string }) => `${name} opnieuw proberen`,
      de: ({ name }: { name: string }) => `${name} erneut versuchen`
    },
    /** The accessible name of a chip's remove button. */
    removeNamed: {
      en: ({ name }: { name: string }) => `Remove ${name}`,
      nl: ({ name }: { name: string }) => `${name} verwijderen`,
      de: ({ name }: { name: string }) => `${name} entfernen`
    },
    /** Under the tray while a chip is not ready: why Send is off. */
    waiting: {
      en: 'Send is available once every attachment is ready or removed.',
      nl: 'Versturen kan zodra elke bijlage klaar of verwijderd is.',
      de: 'Senden ist möglich, sobald jeder Anhang bereit oder entfernt ist.'
    }
  },
  requests: {
    /** Names the bot a request comes from; the layer is over every chat, not only the bot's own. */
    from: {
      en: ({ name }: { name: string }) => `From ${name}`,
      nl: ({ name }: { name: string }) => `Van ${name}`,
      de: ({ name }: { name: string }) => `Von ${name}`
    },
    /** How many more are waiting behind the one on screen. */
    more: {
      en: ({ count }: { count: number }) => (count === 1 ? '1 more waiting' : `${count} more waiting`),
      nl: ({ count }: { count: number }) => (count === 1 ? '1 andere wacht nog' : `${count} andere wachten nog`),
      de: ({ count }: { count: number }) => (count === 1 ? '1 weitere wartet' : `${count} weitere warten`)
    },
    /** Said politely when the request on screen was withdrawn by the gateway. */
    withdrawn: {
      en: ({ name }: { name: string }) => `The request from ${name} was withdrawn.`,
      nl: ({ name }: { name: string }) => `Het verzoek van ${name} is ingetrokken.`,
      de: ({ name }: { name: string }) => `Die Anfrage von ${name} wurde zurückgezogen.`
    },
    /** Said politely when the request on screen ran out of time on the gateway. */
    timedOut: {
      en: ({ name }: { name: string }) => `The request from ${name} timed out.`,
      nl: ({ name }: { name: string }) => `Het verzoek van ${name} is verlopen.`,
      de: ({ name }: { name: string }) => `Die Anfrage von ${name} ist abgelaufen.`
    },
    /** Shown over the chat when an answer did not reach the gateway. */
    answerFailed: {
      en: ({ message }: { message: string }) => `The answer was not delivered: ${message}`,
      nl: ({ message }: { message: string }) => `Het antwoord is niet aangekomen: ${message}`,
      de: ({ message }: { message: string }) => `Die Antwort wurde nicht zugestellt: ${message}`
    }
  },
  passkeys: {
    /** Under the confirmation's title: who asks, in fixed words (never the agent's). */
    sheetLead: {
      en: ({ host }: { host: string }) => `${host} asks you to confirm this with your passkey.`,
      nl: ({ host }: { host: string }) => `${host} vraagt je dit te bevestigen met je passkey.`,
      de: ({ host }: { host: string }) => `${host} bittet dich, dies mit deinem Passkey zu bestätigen.`
    },
    close: {
      en: 'Close',
      nl: 'Sluiten',
      de: 'Schließen'
    },
    /** Said politely when another device answered the confirmation on screen. */
    answeredElsewhere: {
      en: ({ name }: { name: string }) => `The request from ${name} was answered on another device.`,
      nl: ({ name }: { name: string }) => `Het verzoek van ${name} is op een ander apparaat beantwoord.`,
      de: ({ name }: { name: string }) => `Die Anfrage von ${name} wurde auf einem anderen Gerät beantwortet.`
    },
    notice: {
      gatewayIdMismatch: {
        en: 'This gateway presents itself differently from when you added your passkey here. Its passkey requests are refused; ask whoever runs it.',
        nl: 'Deze gateway presenteert zich anders dan toen je hier je passkey toevoegde. Passkey-verzoeken van deze gateway worden geweigerd; vraag het na bij wie hem beheert.',
        de: 'Dieses Gateway gibt sich anders aus als beim Hinzufügen deines Passkeys. Seine Passkey-Anfragen werden abgelehnt; frag die Person, die es betreibt.'
      },
      gatewayIdConflict: {
        en: 'This gateway presents the identity of another gateway you use in this browser. Its passkey requests are refused.',
        nl: 'Deze gateway gebruikt de identiteit van een andere gateway die je in deze browser gebruikt. Passkey-verzoeken van deze gateway worden geweigerd.',
        de: 'Dieses Gateway gibt sich als ein anderes Gateway aus, das du in diesem Browser nutzt. Seine Passkey-Anfragen werden abgelehnt.'
      },
      unsupportedVersion: {
        en: 'A passkey request came in a form this version of Hermie does not know. It was refused.',
        nl: 'Er kwam een passkey-verzoek in een vorm die deze versie van Hermie niet kent. Het is geweigerd.',
        de: 'Eine Passkey-Anfrage kam in einer Form, die diese Version von Hermie nicht kennt. Sie wurde abgelehnt.'
      },
      noCredential: {
        en: 'A passkey request named no passkey of this site. It was refused.',
        nl: 'Een passkey-verzoek noemde geen passkey van deze site. Het is geweigerd.',
        de: 'Eine Passkey-Anfrage nannte keinen Passkey dieser Seite. Sie wurde abgelehnt.'
      },
      malformedRequest: {
        en: 'A passkey request could not be read. It was refused.',
        nl: 'Een passkey-verzoek kon niet gelezen worden. Het is geweigerd.',
        de: 'Eine Passkey-Anfrage konnte nicht gelesen werden. Sie wurde abgelehnt.'
      },
      baseUrlNotListed: {
        en: 'This gateway does not list this page’s address for passkeys, so this page does not offer them here. Ask whoever runs the gateway to add the address.',
        nl: 'Deze gateway heeft het adres van deze pagina niet in zijn lijst voor passkeys, dus deze pagina biedt ze hier niet aan. Vraag wie de gateway beheert om het adres toe te voegen.',
        de: 'Dieses Gateway führt die Adresse dieser Seite nicht in seiner Liste für Passkeys, deshalb bietet diese Seite sie hier nicht an. Bitte die Person, die das Gateway betreibt, die Adresse einzutragen.'
      },
      credentialAdded: {
        en: ({ name }: { name: string }) =>
          `A passkey was added to your account without this browser: ${name}. If that was not you, remove it and tell whoever runs the gateway.`,
        nl: ({ name }: { name: string }) =>
          `Er is zonder deze browser een passkey aan je account toegevoegd: ${name}. Was jij dat niet, verwijder hem dan en laat het weten aan wie de gateway beheert.`,
        de: ({ name }: { name: string }) =>
          `Deinem Konto wurde ohne diesen Browser ein Passkey hinzugefügt: ${name}. Warst du das nicht, entferne ihn und sag der Person Bescheid, die das Gateway betreibt.`
      },
      credentialRevoked: {
        en: ({ name }: { name: string }) => `A passkey was removed from your account without this browser: ${name}.`,
        nl: ({ name }: { name: string }) => `Er is zonder deze browser een passkey van je account verwijderd: ${name}.`,
        de: ({ name }: { name: string }) => `Von deinem Konto wurde ohne diesen Browser ein Passkey entfernt: ${name}.`
      }
    },
    settings: {
      title: {
        en: 'Passkeys',
        nl: 'Passkeys',
        de: 'Passkeys'
      }
    }
  },
  secureInput: {
    /** On the chat: a prompt ran out of time before it was answered. */
    noticeExpired: {
      en: ({ name }: { name: string }) => `The request from ${name} expired. Nothing was sent.`,
      nl: ({ name }: { name: string }) => `Het verzoek van ${name} is verlopen. Er is niets verstuurd.`,
      de: ({ name }: { name: string }) => `Die Anfrage von ${name} ist abgelaufen. Es wurde nichts gesendet.`
    },
    /** On the chat: the bot stopped asking before it was answered. */
    noticeWithdrawn: {
      en: ({ name }: { name: string }) => `${name} no longer asks for this. Nothing was sent.`,
      nl: ({ name }: { name: string }) => `${name} vraagt hier niet meer om. Er is niets verstuurd.`,
      de: ({ name }: { name: string }) => `${name} fragt nicht mehr danach. Es wurde nichts gesendet.`
    },
    /** On the chat: a prompt ended while the connection was down; a reconnect found it gone. */
    noticeLapsed: {
      en: ({ name }: { name: string }) =>
        `The request from ${name} ended while the connection was down. Nothing was sent.`,
      nl: ({ name }: { name: string }) =>
        `Het verzoek van ${name} is beëindigd terwijl de verbinding weg was. Er is niets verstuurd.`,
      de: ({ name }: { name: string }) =>
        `Die Anfrage von ${name} endete, während die Verbindung weg war. Es wurde nichts gesendet.`
    },
    /** On the chat: an answer went out just as the gateway stopped waiting; it may not have been taken. */
    noticeMayNotHaveArrived: {
      en: ({ name }: { name: string }) =>
        `Your answer to ${name} may not have arrived: the request ended at the same moment.`,
      nl: ({ name }: { name: string }) =>
        `Je antwoord aan ${name} is mogelijk niet aangekomen: het verzoek eindigde op hetzelfde moment.`,
      de: ({ name }: { name: string }) =>
        `Deine Antwort an ${name} ist vielleicht nicht angekommen: Die Anfrage endete im selben Moment.`
    },
    /** On the chat: the bot asked for something only the desktop app can do, and the page said no. */
    noticeUnsupported: {
      en: ({ name, method }: { name: string; method: string }) =>
        `${name} sent a request that needs the Hermes desktop app (${method}). It was declined here.`,
      nl: ({ name, method }: { name: string; method: string }) =>
        `${name} stuurde een verzoek dat de Hermes-desktop-app nodig heeft (${method}). Het is hier geweigerd.`,
      de: ({ name, method }: { name: string; method: string }) =>
        `${name} hat eine Anfrage gesendet, die die Hermes-Desktop-App braucht (${method}). Sie wurde hier abgelehnt.`
    },
    /** Takes a notice away. */
    close: {
      en: 'Close',
      nl: 'Sluiten',
      de: 'Schließen'
    }
  },
  gatewayNotices: {
    /** The area over the page where every notice is drawn: its accessible name. */
    area: {
      en: 'Notices',
      nl: 'Meldingen',
      de: 'Hinweise'
    },
    /** The list of the gateway's notices over the page: its accessible name. */
    label: {
      en: 'Notices from the gateway',
      nl: 'Meldingen van de gateway',
      de: 'Hinweise vom Gateway'
    },
    /** Before a notice that is about one chat: whose. */
    fromBot: {
      en: ({ name }: { name: string }) => `From ${name}:`,
      nl: ({ name }: { name: string }) => `Van ${name}:`,
      de: ({ name }: { name: string }) => `Von ${name}:`
    },
    /** Takes a notice away; its accessible name says which. */
    close: {
      en: 'Close',
      nl: 'Sluiten',
      de: 'Schließen'
    },
    /** The close button's accessible name. */
    closeLabel: {
      en: ({ text }: { text: string }) => `Close the notice: ${text}`,
      nl: ({ text }: { text: string }) => `Melding sluiten: ${text}`,
      de: ({ text }: { text: string }) => `Hinweis schließen: ${text}`
    }
  },
  connections: {
    /** Announced when a card's time ran out. */
    expired: {
      en: ({ name }: { name: string }) => `The time to connect a service for ${name} ran out.`,
      nl: ({ name }: { name: string }) => `De tijd om een dienst te koppelen voor ${name} is om.`,
      de: ({ name }: { name: string }) => `Die Zeit, einen Dienst für ${name} zu verbinden, ist abgelaufen.`
    },
    /** Announced when a card was settled or withdrawn without the sheet. */
    done: {
      en: ({ name }: { name: string }) => `${name} is no longer waiting for a connection.`,
      nl: ({ name }: { name: string }) => `${name} wacht niet meer op een koppeling.`,
      de: ({ name }: { name: string }) => `${name} wartet nicht mehr auf eine Verbindung.`
    }
  },
  identity: {
    /** In the sidebar: the gateway answered who is signed in without naming an account. */
    anonymous: {
      en: 'This gateway does not say who you are, so your messages are not marked as yours and nobody else’s are told apart.',
      nl: 'Deze gateway zegt niet wie je bent, dus je berichten worden niet als de jouwe gemarkeerd en die van anderen worden niet onderscheiden.',
      de: 'Dieses Gateway sagt nicht, wer du bist. Deine Nachrichten werden daher nicht als deine markiert und die anderer nicht unterschieden.'
    },
    /** In the sidebar: the gateway could not be asked who is signed in. */
    failed: {
      en: 'Hermie could not ask the gateway who you are, so your messages are not marked as yours. It asks again when the connection comes back.',
      nl: 'Hermie kon de gateway niet vragen wie je bent, dus je berichten worden niet als de jouwe gemarkeerd. Hermie vraagt het opnieuw zodra de verbinding terug is.',
      de: 'Hermie konnte das Gateway nicht fragen, wer du bist. Deine Nachrichten werden daher nicht als deine markiert. Hermie fragt erneut, sobald die Verbindung zurück ist.'
    }
  },
  resumeProgress: {
    /** On the chat while the gateway loads the conversation behind a resume. */
    loading: {
      en: 'The gateway is still loading this conversation…',
      nl: 'De gateway laadt dit gesprek nog…',
      de: 'Das Gateway lädt dieses Gespräch noch…'
    },
    /** On the chat when the gateway could not load the conversation. */
    failed: {
      en: 'The gateway could not load this conversation’s history.',
      nl: 'De gateway kon de geschiedenis van dit gesprek niet laden.',
      de: 'Das Gateway konnte den Verlauf dieses Gesprächs nicht laden.'
    },
    /** After the failure line: the gateway's reason. */
    reason: {
      en: ({ reason }: { reason: string }) => `The gateway says: ${reason}`,
      nl: ({ reason }: { reason: string }) => `De gateway zegt: ${reason}`,
      de: ({ reason }: { reason: string }) => `Das Gateway sagt: ${reason}`
    },
    close: {
      en: 'Close',
      nl: 'Sluiten',
      de: 'Schließen'
    }
  },
  language: {
    /** The first row of the language picker: a browser has a language list, not one device language. */
    followBrowser: {
      en: 'Follow browser',
      nl: 'Volg browser',
      de: 'Browser folgen'
    }
  }
} as const satisfies Branch

export type Translated<T> = T extends { readonly en: infer V } ? V : { readonly [K in keyof T]: Translated<T[K]> }

export type WebStrings = Translated<typeof WEB_STRINGS_SOURCE>

const LEAF_LANGUAGES: readonly Locale[] = ['en', 'nl', 'de']

const isLeaf = (node: unknown): node is Leaf<string | ((args: never) => string)> =>
  typeof node === 'object' && node !== null && LEAF_LANGUAGES.every(locale => locale in node)

export function localise(source: Branch): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  for (const [name, node] of Object.entries(source)) {
    if (!isLeaf(node)) {
      out[name] = localise(node as Branch)
    } else if (typeof node.en === 'function') {
      out[name] = (args: unknown): string => (node[activeLocale()] as (args: unknown) => string)(args)
    } else {
      Object.defineProperty(out, name, { enumerable: true, get: () => node[activeLocale()] as string })
    }
  }

  return out
}

/** The web-only strings in the language the reader is using. */
export const webStrings = localise(WEB_STRINGS_SOURCE) as unknown as WebStrings
