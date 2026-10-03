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
