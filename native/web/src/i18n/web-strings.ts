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
    },
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
