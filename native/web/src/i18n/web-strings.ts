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

interface Branch {
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
    /** A clarify question left unanswered on purpose: the bot is told "no answer". */
    skip: {
      en: 'Skip',
      nl: 'Overslaan',
      de: 'Überspringen'
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
    /** The name of the box with the confirmation's detail, shown exactly as the gateway sent it. */
    detailLabel: {
      en: 'Details',
      nl: 'Details',
      de: 'Details'
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
    close: {
      en: 'Close',
      nl: 'Sluiten',
      de: 'Schließen'
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
      },
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
        en: 'Add a passkey from this browser',
        nl: 'Een passkey van deze browser toevoegen',
        de: 'Einen Passkey aus diesem Browser hinzufügen'
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
        en: 'Add a passkey',
        nl: 'Passkey toevoegen',
        de: 'Passkey hinzufügen'
      },
      enrolled: {
        en: 'The passkey was added.',
        nl: 'De passkey is toegevoegd.',
        de: 'Der Passkey wurde hinzugefügt.'
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
  language: {
    /** The first row of the language picker: a browser has a language list, not one device language. */
    followBrowser: {
      en: 'Follow browser',
      nl: 'Volg browser',
      de: 'Browser folgen'
    }
  }
} as const satisfies Branch

type Translated<T> = T extends { readonly en: infer V } ? V : { readonly [K in keyof T]: Translated<T[K]> }

export type WebStrings = Translated<typeof WEB_STRINGS_SOURCE>

const LEAF_LANGUAGES: readonly Locale[] = ['en', 'nl', 'de']

const isLeaf = (node: unknown): node is Leaf<string | ((args: never) => string)> =>
  typeof node === 'object' && node !== null && LEAF_LANGUAGES.every(locale => locale in node)

function localise(source: Branch): Record<string, unknown> {
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
