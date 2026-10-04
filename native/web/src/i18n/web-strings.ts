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
  tokenMode: {
    /** The token prompt's lead: what this gateway is, and where the token is kept. */
    lead: {
      en: 'This gateway has no sign-in: it lets in whoever has its session token. Hermie keeps the token in this tab’s memory only and never stores it.',
      nl: 'Deze gateway heeft geen inlog: hij laat iedereen toe die zijn session token heeft. Hermie houdt het token alleen in het geheugen van dit tabblad en slaat het nooit op.',
      de: 'Dieses Gateway hat keine Anmeldung: Es lässt jeden herein, der sein Session-Token hat. Hermie behält das Token nur im Speicher dieses Tabs und speichert es nie.'
    },
    /** Why the prompt is shown: the dashboard's page carried no token Hermie could read. */
    absent: {
      en: 'Hermie could not read the token from this gateway’s own dashboard page.',
      nl: 'Hermie kon het token niet lezen van de eigen dashboardpagina van deze gateway.',
      de: 'Hermie konnte das Token nicht von der eigenen Dashboard-Seite dieses Gateways lesen.'
    },
    /** Why the prompt is shown: the gateway refused the token its dashboard page carried. */
    rejected: {
      en: 'The gateway did not accept the token from its dashboard page. It may have restarted with a new one.',
      nl: 'De gateway accepteerde het token van zijn dashboardpagina niet. Misschien is hij opnieuw gestart met een nieuw token.',
      de: 'Das Gateway hat das Token von seiner Dashboard-Seite nicht angenommen. Vielleicht wurde es mit einem neuen Token neu gestartet.'
    },
    /** Why the prompt is shown: the reader asked Hermie to forget the token. */
    forgotten: {
      en: 'Hermie has forgotten the token, and the conversations this browser kept for this gateway.',
      nl: 'Hermie is het token vergeten, en ook de gesprekken die deze browser voor deze gateway bewaarde.',
      de: 'Hermie hat das Token vergessen, und auch die Verläufe, die dieser Browser für dieses Gateway gespeichert hatte.'
    },
    /** Under the field, when the gateway refused the token that was typed. */
    wrong: {
      en: 'The gateway did not accept this token. Check it and try again.',
      nl: 'De gateway accepteerde dit token niet. Controleer het en probeer het opnieuw.',
      de: 'Das Gateway hat dieses Token nicht angenommen. Prüfe es und versuche es erneut.'
    },
    /** While a typed token is being checked. */
    checking: {
      en: 'Checking the token…',
      nl: 'Token controleren…',
      de: 'Token wird geprüft…'
    },
    /** The button that reads the token from the dashboard's page again. */
    readAgain: {
      en: 'Read it from the dashboard again',
      nl: 'Opnieuw van het dashboard lezen',
      de: 'Erneut vom Dashboard lesen'
    },
    /** In the sidebar, where a gated gateway names who is signed in. */
    noSignIn: {
      en: 'No sign-in on this gateway',
      nl: 'Geen inlog op deze gateway',
      de: 'Keine Anmeldung auf diesem Gateway'
    },
    /** The way out on a gateway without sign-in: the sign-out's place in the sidebar and in Settings, Account. */
    forget: {
      en: 'Forget the token',
      nl: 'Token vergeten',
      de: 'Token vergessen'
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
    /** The sidebar's button that opens the list of keyboard shortcuts (which is a chunk of its own). */
    shortcuts: {
      en: 'Keyboard shortcuts',
      nl: 'Sneltoetsen',
      de: 'Tastenkürzel'
    },
    /** A hint under the chat list when the gateway has no Hermie plugin; the client works without it. */
    noPlugin: {
      en: 'This gateway has no Hermie plugin. Chats work, but notifications need it.',
      nl: 'Deze gateway heeft geen Hermie-plugin. Chats werken, maar voor meldingen is de plugin nodig.',
      de: 'Dieses Gateway hat kein Hermie-Plugin. Chats funktionieren, aber Benachrichtigungen brauchen es.'
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
    /** Said politely when a question took the dialog from a form, a file request or a draft that was open (not Later). */
    madeWay: {
      en: 'A question needs your answer first. What you were filling in is kept and comes back afterwards.',
      nl: 'Er is eerst een vraag die je antwoord nodig heeft. Wat je aan het invullen was blijft bewaard en komt daarna terug.',
      de: 'Zuerst braucht eine Frage deine Antwort. Was du gerade ausgefüllt hast, bleibt erhalten und kommt danach zurück.'
    },
    /** Said when a request ended while it was not known whether the answer sent from here reached the gateway. */
    answerMayNotHaveArrived: {
      en: ({ name }: { name: string }) => `Your answer to ${name} may not have arrived before the request ended.`,
      nl: ({ name }: { name: string }) =>
        `Je antwoord aan ${name} is mogelijk niet aangekomen voordat het verzoek eindigde.`,
      de: ({ name }: { name: string }) =>
        `Deine Antwort an ${name} ist möglicherweise nicht angekommen, bevor die Anfrage endete.`
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
    /** Said politely when the gateway's list after a reconnect did not name the confirmation on screen. */
    closedHere: {
      en: ({ name }: { name: string }) =>
        `The gateway no longer lists the confirmation from ${name}. It comes back if it is still open.`,
      nl: ({ name }: { name: string }) =>
        `De gateway toont de bevestiging van ${name} niet meer. Ze komt terug als ze nog openstaat.`,
      de: ({ name }: { name: string }) =>
        `Das Gateway listet die Bestätigung von ${name} nicht mehr auf. Sie kommt wieder, wenn sie noch offen ist.`
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
  mcp: {
    settings: {
      /** The page's heading and the link to it: the protocol's own name. */
      title: {
        en: 'MCP',
        nl: 'MCP',
        de: 'MCP'
      }
    }
  },
  secureInput: {
    /** On the chat: a prompt ended while the connection was down; a reconnect found it gone. */
    noticeLapsed: {
      en: ({ name }: { name: string }) =>
        `The request from ${name} ended while the connection was down. Nothing was sent.`,
      nl: ({ name }: { name: string }) =>
        `Het verzoek van ${name} is beëindigd terwijl de verbinding weg was. Er is niets verstuurd.`,
      de: ({ name }: { name: string }) =>
        `Die Anfrage von ${name} endete, während die Verbindung weg war. Es wurde nichts gesendet.`
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
