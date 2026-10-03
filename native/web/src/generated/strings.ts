// Written by `npm run i18n` from contract/i18n/catalogue.json. Do not edit: change the
// TypeScript catalogues in expo/hermie/src/i18n and run it again. See docs/i18n.md.

import { createStrings } from '../i18n/catalogue'

/** Every string the Expo app has, under the keys the Expo app uses. */
export interface Strings {
  readonly app: {
    readonly activity: {
      readonly counters: {
        /** Deliveries out */
        readonly deliveries: string
        /** Sub-agents */
        readonly subagents: string
        /** Bots working */
        readonly working: string
      }
      /** Your bots have not talked to each other yet. When one messages another or delegates a task, it shows up here. */
      readonly empty: string
      /** Nothing to show while the gateway is out of reach. */
      readonly emptyOffline: string
      /** The timeline could not be loaded: {message} */
      readonly failed: (args: { message: string }) => string
      readonly groupStatus: {
        /** dispatched */
        readonly dispatched: string
        /** done */
        readonly done: string
        /** failed */
        readonly failed: string
        /** running */
        readonly running: string
        /** An entry for a key that arrives at run time, or undefined for one this table does not have. */
        readonly [key: string]: string | undefined
      }
      /** Reading every conversation… */
      readonly loading: string
      /** Open the chat with {bot} */
      readonly openChat: (args: { bot: string }) => string
      /** {from} ↩︎ {to} */
      readonly reply: (args: { from: string; to: string }) => string
      /** {bot} spawned {count} agents */
      readonly spawned: (args: { bot: string; count: number }) => string
      /** Messages between your bots, and the agents they put to work. */
      readonly subtitle: string
      /** Activity */
      readonly title: string
      /** {from} → {to} */
      readonly to: (args: { from: string; to: string }) => string
      /** Today */
      readonly today: string
      /** Yesterday */
      readonly yesterday: string
    }
    readonly app: {
      /** Starting… */
      readonly loading: string
      /** Hermie */
      readonly name: string
    }
    readonly auth: {
      /** This sign-in cannot be refreshed — it ends when its access token expires. The gateway’s provider needs the offline_access scope. */
      readonly noRefreshToken: string
      /** How to fix this */
      readonly noRefreshTokenLink: string
    }
    readonly botProfile: {
      /** ABOUT THIS BOT */
      readonly about: string
      /** COLOUR */
      readonly colour: string
      /** This chat only. It tints the bubbles, the avatar ring and the row in the list. */
      readonly colourHint: string
      /** DESCRIPTION */
      readonly description: string
      /** What this bot is for */
      readonly descriptionPlaceholder: string
      /** Gateway */
      readonly gatewayVersion: string
      /** Edit profile */
      readonly menuItem: string
      /** Model */
      readonly model: string
      /** Edit {name}'s profile */
      readonly open: (args: { name: string }) => string
      /** PHOTO */
      readonly photo: string
      /** Choose a photo */
      readonly photoChange: string
      /** That photo could not be uploaded. */
      readonly photoFailed: string
      /** Shown on the chat list, the header and every message this bot sends. */
      readonly photoHint: string
      /** Remove photo */
      readonly photoRemove: string
      /** Change photo */
      readonly photoReplace: string
      /** Provider */
      readonly provider: string
      /** Save */
      readonly save: string
      /** The gateway would not save that. */
      readonly saveFailed: string
      /** Saving… */
      readonly saving: string
      /** Session */
      readonly session: string
      /** Profile */
      readonly title: string
      /** — */
      readonly unknown: string
    }
    readonly bots: {
      /** {count} conversations */
      readonly conversations: (args: { count: number }) => string
      /** Default */
      readonly defaultBot: string
      /** This gateway has no bot profiles yet. Create one with `hermes profile create`. */
      readonly empty: string
      /** The bot list could not be loaded: {message} */
      readonly failed: (args: { message: string }) => string
      /** Your conversations stay with your gateway. */
      readonly footnote: string
      /** Reading the roster… */
      readonly loading: string
      /** Open {bot}’s chat at this message */
      readonly messageOpen: (args: { bot: string }) => string
      /** IN MESSAGES */
      readonly messagesHeader: string
      /** Only the best match per chat is shown. */
      readonly messagesHint: string
      /** No messages match. */
      readonly messagesNone: string
      /** Searching messages… */
      readonly messagesSearching: string
      /** More */
      readonly moreActions: string
      /** Needs your input */
      readonly needsInput: string
      /** No conversation matches “{query}”. */
      readonly noMatches: (args: { query: string }) => string
      /** No messages yet */
      readonly noPreview: string
      /** Offline — showing the last saved list. */
      readonly offline: string
      /** working */
      readonly running: string
      /** Search chats */
      readonly search: string
      /** MESSAGES */
      readonly section: string
      /** {count} shares waiting to send */
      readonly sharePending: (args: { count: number }) => string
      /** CHATS */
      readonly sidebarHeader: string
      /** Gateway: {name} */
      readonly switchGateway: (args: { name: string }) => string
      /** Choose which gateway this list belongs to */
      readonly switchGatewayHint: string
      /** Chats */
      readonly title: string
      /** New */
      readonly unread: string
      /** {count} unread messages */
      readonly unreadLabel: (args: { count: number }) => string
    }
    readonly chat: {
      /** Answered: {answer} */
      readonly answered: (args: { answer: string }) => string
      /** Approval requested */
      readonly approvalTitle: string
      readonly attach: {
        /** Cancel */
        readonly cancel: string
        /** Upload failed */
        readonly chipFailed: string
        /** No workspace to upload into */
        readonly chipNoWorkspace: string
        /** The gateway refused it */
        readonly chipRefused: string
        /** Too large · {megabytes} MB max */
        readonly chipTooLarge: (args: { megabytes: number }) => string
        /** The attachment could not be added: {message} */
        readonly failed: (args: { message: string }) => string
        /** File */
        readonly file: string
        /** Open Settings */
        readonly openSettings: string
        /** Hermie needs access to your photo library to attach an image. Allow it in Settings. */
        readonly permission: string
        /** Photo library */
        readonly photo: string
        /** Add an attachment */
        readonly title: string
        /** The file was not sent. {message} */
        readonly uploadFailed: (args: { message: string }) => string
      }
      /** Withdrawn */
      readonly cancelled: string
      /** The bot has a question */
      readonly clarifyTitle: string
      readonly connection: {
        /** Connecting to your gateway… */
        readonly connecting: string
        /** Offline */
        readonly offline: string
        /** Reconnecting… */
        readonly reconnecting: string
        /** Try now */
        readonly retry: string
      }
      /** Nothing has been said in this chat yet. */
      readonly empty: string
      /** {message} */
      readonly expensiveModel: (args: { message: string }) => string
      /** This conversation could not be opened: {message} */
      readonly failed: (args: { message: string }) => string
      /** “{query}” was matched by the gateway, but it is not in the visible text of this chat. */
      readonly findExhausted: (args: { query: string }) => string
      /** “{query}” is in this chat, further back than it has loaded. */
      readonly findMissed: (args: { query: string }) => string
      /** Loading the conversation… */
      readonly hydrating: string
      /** Showing the last saved copy of this conversation. */
      readonly offlineCopy: string
      /** Pick a conversation to start reading. */
      readonly pickBot: string
      /** Try again */
      readonly retry: string
      /** Send */
      readonly send: string
      /** Setting not changed: {message} */
      readonly settingRefused: (args: { message: string }) => string
      /** This conversation lost its connection to the gateway. It reattaches on the next open. */
      readonly stale: string
      /** Stop */
      readonly stop: string
      /** {count} subagents running */
      readonly subagents: (args: { count: number }) => string
      readonly subtitle: {
        /** Connecting… */
        readonly connecting: string
        /** Delegating… */
        readonly delegating: string
        /** Online */
        readonly idle: string
        /** Offline */
        readonly offline: string
        /** Queued */
        readonly queued: string
        /** Reconnecting… */
        readonly reconnecting: string
        /** Running {tool}… */
        readonly running: (args: { tool: string }) => string
        /** Signed out */
        readonly signedOut: string
        /** Thinking… */
        readonly thinking: string
        /** Typing… */
        readonly typing: string
        /** Waiting for you */
        readonly waiting: string
        /** Working… */
        readonly working: string
      }
      /** Thinking */
      readonly thinking: string
      /** running */
      readonly toolRunning: string
      /** Someone else started a turn… */
      readonly unknownAuthor: string
    }
    readonly common: {
      /** Add */
      readonly add: string
      /** Back */
      readonly back: string
      /** Cancel */
      readonly cancel: string
      /** Continue */
      readonly continue: string
      /** Dismiss */
      readonly dismiss: string
      /** Done */
      readonly done: string
      /** Nothing matches that. */
      readonly noMatches: string
      /** Nothing to choose from. */
      readonly nothingToPick: string
      /** Open in browser instead */
      readonly openInBrowser: string
      /** Remove */
      readonly remove: string
      /** Try again */
      readonly retry: string
      /** Search */
      readonly search: string
      /** Sign in */
      readonly signIn: string
    }
    readonly connection: {
      readonly reauth: {
        /** Sign in */
        readonly action: string
        /** Your session on this gateway has expired. */
        readonly message: string
        /** Signing in… */
        readonly saving: string
        /** Update token */
        readonly tokenAction: string
      }
      readonly status: {
        /** Authenticating… */
        readonly authenticating: string
        /** Connecting… */
        readonly connecting: string
        /** Disconnected */
        readonly disconnected: string
        /** Not supported */
        readonly incompatible: string
        /** Signed out */
        readonly needs_signin: string
        /** Offline */
        readonly offline: string
        /** Paused */
        readonly paused: string
        /** Checking the gateway… */
        readonly probing: string
        /** Connected */
        readonly ready: string
        /** Reconnecting… */
        readonly reconnecting: string
      }
    }
    readonly errors: {
      /** An access proxy answered HTTP {status} before the gateway did. Add its headers under Advanced, or exempt /api/status, /auth/* and /login from it. */
      readonly authProxy: (args: { status: number }) => string
      /** The WebSocket closed without a reason. A proxy in front of the gateway usually has to be configured to pass WebSocket upgrades through. */
      readonly closeAbnormal: string
      /** The gateway rejected the credentials when the WebSocket opened. Sign in again. */
      readonly closeAuth: string
      /** Chat is switched off on this gateway. */
      readonly closeChatOff: string
      /** The gateway does not trust this address. Set its `dashboard.public_url` to the address you entered and restart it. */
      readonly closeHost: string
      /** Another client took this connection over. Close the other client and test again. */
      readonly closeTakenOver: string
      /** This gateway is too old for Hermie. Update Hermes on the gateway. */
      readonly incompatible: string
      /** This looks like a web page, not a gateway. */
      readonly landingPage: string
      /** Could not reach {host}. Check the address, and that the gateway is running and reachable from this device. */
      readonly network: (args: { host: string }) => string
      /** Could not reach {host} over https://. It is either not answering there, or serving a certificate this device does not trust. Leave the https:// off and Hermi... */
      readonly networkOverHttps: (args: { host: string }) => string
      /** {host} answered, but not like a Hermes gateway. Check the address and any path prefix. */
      readonly notHermes: (args: { host: string }) => string
      /** Add the proxy’s credentials */
      readonly openFrontDoor: string
      /** This address only answers on a private network — is this device on the VPN/tailnet? */
      readonly privateNetworkOnly: string
      /** The gateway requires a sign-in but reports no identity providers. Configure one on the gateway and try again. */
      readonly providersUnavailable: string
      /** {from} redirected to {to}, which is a different host. Nothing was read from it. */
      readonly redirected: (args: { from: string; to: string }) => string
      /** The gateway answered HTTP {status}. It is running but unhealthy; check its logs. */
      readonly server: (args: { status: number }) => string
      /** The gateway rejected the credentials. Sign in again. */
      readonly signedOut: string
      /** {host} did not answer in time. It may be starting up or behind a slow link. */
      readonly timeout: (args: { host: string }) => string
      /** The secure connection to {host} failed. A self-signed certificate has to be trusted by this device first — or, if the gateway serves plain http there, leave ... */
      readonly tls: (args: { host: string }) => string
      /** Something went wrong. */
      readonly unknown: string
      /** Use {host} instead */
      readonly useRedirectTarget: (args: { host: string }) => string
    }
    readonly gateway: {
      /** Connection settings */
      readonly connectionSettings: string
      /** {ms} ms */
      readonly latency: (args: { ms: number }) => string
      /** No gateway */
      readonly noHost: string
    }
    readonly layout: {
      readonly accents: {
        /** Default */
        readonly default: string
        /** Graphite */
        readonly graphite: string
        /** Green */
        readonly green: string
        /** Indigo */
        readonly indigo: string
        /** Lime */
        readonly lime: string
        /** Magenta */
        readonly magenta: string
        /** Orange */
        readonly orange: string
        /** Red */
        readonly red: string
        /** Slate */
        readonly slate: string
        /** Teal */
        readonly teal: string
        /** Violet */
        readonly violet: string
      }
      /** Archive */
      readonly archive: string
      /** Archived ({count}) */
      readonly archived: (args: { count: number }) => string
      /** Archived · excluded from filters and counts */
      readonly archivedPreview: string
      /** Close */
      readonly close: string
      /** Hide the chats in {name} */
      readonly collapseFolder: (args: { name: string }) => string
      /** Colour */
      readonly colour: string
      /** Colour for {name} */
      readonly colourOf: (args: { name: string }) => string
      /** Delete folder */
      readonly deleteFolder: string
      /** Moving {name} */
      readonly dragging: (args: { name: string }) => string
      /** Show the chats in {name} */
      readonly expandFolder: (args: { name: string }) => string
      /** Actions for the {name} folder */
      readonly folderActions: (args: { name: string }) => string
      /** Folder colour */
      readonly folderColour: string
      /** No chats in this folder */
      readonly folderEmpty: string
      /** Folder name */
      readonly folderName: string
      /** Waiting for you */
      readonly folderNeedsInput: string
      /** {count} unread */
      readonly folderUnread: (args: { count: number }) => string
      /** Mark as read */
      readonly markRead: string
      /** Move down */
      readonly moveDown: string
      /** Move to {folder} */
      readonly moveToFolder: (args: { folder: string }) => string
      /** Move to folder */
      readonly moveToFolderMenu: string
      /** Move up */
      readonly moveUp: string
      /** Mute */
      readonly mute: string
      /** Mute folder */
      readonly muteFolder: string
      readonly muteFor: {
        /** For 1 hour */
        readonly "1h": string
        /** For 1 week */
        readonly "1w": string
        /** For 8 hours */
        readonly "8h": string
        /** Until I turn it back on */
        readonly forever: string
      }
      /** Sun | Mon | Tue | Wed | Thu | Fri | Sat */
      readonly muteWeekdays: readonly string[]
      /** Muted */
      readonly muted: string
      /** Muted */
      readonly mutedRow: string
      /** Muted until {when} */
      readonly mutedUntil: (args: { when: string }) => string
      /** Type to rename this folder. */
      readonly nameFolderHint: string
      /** New folder */
      readonly newFolder: string
      /** Open */
      readonly openChat: string
      /** Pin */
      readonly pin: string
      /** Pinned */
      readonly pinnedRow: string
      /** Remove */
      readonly remove: string
      /** Delete the {name} folder */
      readonly removeFolder: (args: { name: string }) => string
      /** Rename */
      readonly rename: string
      /** Actions for {name} */
      readonly rowActions: (args: { name: string }) => string
      /** Show sidebar */
      readonly showSidebar: string
      /** Sidebar, hidden */
      readonly sidebarRail: string
      /** No folder */
      readonly topGroup: string
      /** Unarchive */
      readonly unarchive: string
      /** Unmute */
      readonly unmute: string
      /** Unmute folder */
      readonly unmuteFolder: string
      /** Untitled folder */
      readonly unnamedFolder: string
      /** Unpin */
      readonly unpin: string
    }
    readonly lock: {
      /** Hermie is locked. */
      readonly plateBody: string
      /** Unlock Hermie */
      readonly prompt: string
      /** Hermie is locked, and this device has no passcode or biometric set up to unlock it. Add one in your device settings. */
      readonly stranded: string
      /** Unlock */
      readonly unlock: string
    }
    readonly menuBar: {
      /** Chats */
      readonly chats: string
      /** Close */
      readonly close: string
      /** Hide Sidebar */
      readonly hideSidebar: string
      /** New Conversation */
      readonly newConversation: string
      /** Search… */
      readonly search: string
      /** Settings… */
      readonly settings: string
      /** Show Sidebar */
      readonly showSidebar: string
    }
    readonly onboarding: {
      readonly address: {
        /** Add a header */
        readonly addHeader: string
        /** Advanced */
        readonly advanced: string
        /** Extra request headers are sent with every call and with the sign-in page. A reverse proxy that wants a shared secret needs it here. */
        readonly advancedHint: string
        readonly frontDoor: {
          /** Client ID */
          readonly clientId: string
          /** abc123.access */
          readonly clientIdPlaceholder: string
          /** Client Secret */
          readonly clientSecret: string
          /** Cloudflare Access */
          readonly cloudflare: string
          /** A service token from your Access application. Hermie sends it with every request, the WebSocket and the sign-in page. Exempt /auth/* and /login from the Acce... */
          readonly cloudflareHint: string
          /** Custom headers */
          readonly custom: string
          /** Pick how the proxy in front of your gateway lets Hermie through. Nothing here is sent anywhere but the gateway’s own address. */
          readonly hint: string
          /** This gateway is reached over http://, so the service token is not being sent — it is a long-lived credential for your whole Access tenant. Use https:// for t... */
          readonly insecure: string
          /** IN FRONT OF THE GATEWAY */
          readonly label: string
        }
        /** Header */
        readonly headerName: string
        /** Value */
        readonly headerValue: string
        /** Hide value */
        readonly hideValue: string
        /** Leave the scheme out and Hermie tries https:// first, then http://. Type a scheme yourself to pin it. */
        readonly hint: string
        /** ADDRESS */
        readonly label: string
        /** hermes.example.com */
        readonly placeholder: string
        /** Checking… */
        readonly probing: string
        /** Checking https://, then http://… */
        readonly probingBoth: string
        /** Checking {scheme}… */
        readonly probingScheme: (args: { scheme: string }) => string
        /** Remove the {name} header */
        readonly removeHeader: (args: { name: string }) => string
        /** Hermes {version} · session token required */
        readonly sessionTokenRequired: (args: { version: string }) => string
        /** Show value */
        readonly showValue: string
        /** Hermes {version} · sign-in required via {providers|list(", ", " or ")} */
        readonly signInRequired: (args: { version: string; providers: readonly string[] }) => string
        /** Hermes {version} · sign-in required, but this gateway lists no identity providers. Configure one on the gateway. */
        readonly signInRequiredNoProviders: (args: { version: string }) => string
        /** The address you would open in a browser to reach the gateway dashboard. */
        readonly subtitle: string
        /** Gateway address */
        readonly title: string
      }
      readonly done: {
        /** Hermie could not store the credentials securely on this device: {reason} */
        readonly credentialsNotStored: (args: { reason: string }) => string
        /** Start chatting */
        readonly finish: string
        /** Gateway */
        readonly gateway: string
        /** Try again */
        readonly retry: string
        /** The settings could not be saved: {message} */
        readonly saveFailed: (args: { message: string }) => string
        /** Saving… */
        readonly saving: string
        /** Hermie will store the gateway address on this device and the credentials in the system secret store. */
        readonly subtitle: string
        /** Hermie will remember this gateway in this browser. The session itself stays where the gateway put it — in a cookie Hermie cannot read. */
        readonly subtitleCookie: string
        /** Ready */
        readonly title: string
      }
      readonly notifications: {
        /** Copied */
        readonly copied: string
        /** Copy */
        readonly copy: string
        /** Permission was refused. You can turn it on later in your device settings. */
        readonly denied: string
        /** Turn on notifications */
        readonly enable: string
        /** Notifications are on for this device. */
        readonly enabled: string
        /** Asking… */
        readonly enabling: string
        /** Already running Hermie Web with --push? That keeps working, and you can turn notifications on now. Do not run both — they would notify this device twice. */
        readonly fallback: string
        /** Open guide */
        readonly guide: string
        /** ON THE GATEWAY */
        readonly install: string
        /** Hermie never talks to the plugin. It reads what your gateway already knows, so there is no second address and nothing new to expose. */
        readonly missingHint: string
        /** This gateway has no Hermie plugin, so nothing there can send a notification. It installs with two commands on the machine running `hermes serve`. */
        readonly missingSubtitle: string
        /** Get push notifications */
        readonly missingTitle: string
        /** You can turn this on later in Settings. */
        readonly skip: string
        /** Your gateway can tell this device when a bot answers, asks for something, or finishes a long task. */
        readonly subtitle: string
        /** Notifications */
        readonly title: string
      }
      readonly signIn: {
        /** It requires a sign-in but does not advertise the native_pkce flow, which is the only one a mobile app can complete. Update Hermes on the gateway. */
        readonly blockedBody: string
        /** This gateway is too old for native sign-in */
        readonly blockedTitle: string
        /** Checking whether you are already signed in… */
        readonly checkingSession: string
        /** Provider */
        readonly chooseProvider: string
        /** It requires a sign-in but does not advertise the cookie flow, which is the only one a browser tab can complete. Update Hermes on the gateway. */
        readonly cookieBlockedBody: string
        /** This gateway is too old for browser sign-in */
        readonly cookieBlockedTitle: string
        /** Hide password */
        readonly hidePassword: string
        /** Hide token */
        readonly hideToken: string
        /** Taking you to the sign-in page… */
        readonly leavingForProvider: string
        /** PASSWORD */
        readonly passwordSecret: string
        /** Password */
        readonly passwordSecretLabel: string
        /** Sign in */
        readonly passwordSubmit: string
        /** USER NAME */
        readonly passwordUser: string
        /** User name */
        readonly passwordUserLabel: string
        /** Reading the gateway… */
        readonly probingGateway: string
        /** Served by Hermie Web, talking to {host}. */
        readonly servedFrom: (args: { host: string }) => string
        /** Served by Hermie Web. */
        readonly servedFromUnknown: string
        /** Show password */
        readonly showPassword: string
        /** Show token */
        readonly showToken: string
        /** Sign in with {provider} */
        readonly signInWith: (args: { provider: string }) => string
        /** Sign in again */
        readonly signOutAndRetry: string
        /** Sign out */
        readonly signOutOfSession: string
        /** Signed in */
        readonly signedIn: string
        /** Signed in as {user} */
        readonly signedInAs: (args: { user: string }) => string
        /** Sign-in with SSO is turned off on this Hermie Web. Ask whoever runs it to sign you in another way. */
        readonly ssoOff: string
        /** The gateway hosts the sign-in page. Your browser keeps the session it hands back; Hermie never sees it. */
        readonly subtitleCookie: string
        /** The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device. */
        readonly subtitleNative: string
        /** This gateway is not gated by an identity provider; it authenticates with the session token it prints at startup. */
        readonly subtitleToken: string
        /** Sign in */
        readonly title: string
        /** It authenticates with a session token, and a browser tab has nowhere safe to keep one — anything running in the page could read it. Use the Hermie app, or pu... */
        readonly tokenBlockedBody: string
        /** This gateway cannot be used from a browser */
        readonly tokenBlockedTitle: string
        /** Paste the session token printed by `hermes serve`. */
        readonly tokenHelp: string
        /** SESSION TOKEN */
        readonly tokenLabel: string
        /** Session token */
        readonly tokenPlaceholder: string
        readonly webview: {
          /** Sign-in was cancelled. */
          readonly cancelled: string
          /** Open the sign-in page in your browser, then paste the address it fails to open back here. You can go back and use the in-app page instead. */
          readonly chosen: string
          /** Completing sign-in… */
          readonly exchanging: string
          /** The browser will fail to load a 127.0.0.1 address — that is expected. Copy it out of the address bar and paste it here. */
          readonly fallbackHelp: string
          /** Failed address */
          readonly fallbackLabel: string
          /** http://127.0.0.1:38007/callback?code=… */
          readonly fallbackPlaceholder: string
          /** Use this address */
          readonly fallbackSubmit: string
          /** This gateway needs extra headers, and Android’s in-app browser would forward them to your identity provider. Sign in in your browser instead, then paste the ... */
          readonly headersWithheld: string
          /** The sign-in page answered HTTP {status}. Check the gateway's public address. */
          readonly httpError: (args: { status: number }) => string
          /** The sign-in page could not be loaded: {message} */
          readonly loadError: (args: { message: string }) => string
          /** Opening the sign-in page… */
          readonly loading: string
          /** The sign-in finished without an authorization code. Start the sign-in again. */
          readonly noCode: string
          /** The gateway refused the sign-in: {description} ({error}) */
          readonly providerError: (args: { error: string; description: string }) => string
          /** The sign-in response did not belong to this attempt and was discarded. Start the sign-in again. */
          readonly stateMismatch: string
          /** The sign-in page was open for ten minutes without finishing. Start again when you are ready. */
          readonly timeout: string
          /** Sign in */
          readonly title: string
          /** The in-app browser is not available on this platform. Open the sign-in page in your browser, then paste the address it fails to open back here. */
          readonly unavailable: string
        }
      }
      /** Step {current} of {total} */
      readonly stepCounter: (args: { current: number; total: number }) => string
      readonly test: {
        readonly checklist: {
          /** Profiles */
          readonly profiles: string
          /** REST */
          readonly rest: string
          /** WebSocket */
          readonly socket: string
        }
        /** Connected · {bots} bots */
        readonly connected: (args: { bots: number }) => string
        /** Connected as {user} · {bots} bots */
        readonly connectedAs: (args: { user: string; bots: number }) => string
        /** Something changed since the last test, so it is running again. */
        readonly invalidated: string
        /** The connection works, but this gateway has no bot profiles yet. */
        readonly noBots: string
        /** The connection has not been tested yet. */
        readonly required: string
        /** Try again */
        readonly retry: string
        /** Testing… */
        readonly running: string
        /** Hermie checks the REST surface and then opens the WebSocket, exactly as it will during use. */
        readonly subtitle: string
        /** Test connection */
        readonly title: string
      }
      readonly welcome: {
        /** Set up a gateway */
        readonly action: string
        /** Hermie is a client for Hermes Agent. It talks to one gateway at a time — the machine running `hermes serve` — and chats with the bots that live there. */
        readonly body: string
        /** Nothing is stored until the connection has been tested. */
        readonly note: string
        /** Welcome to Hermie */
        readonly title: string
      }
    }
    readonly presence: {
      /** Needs input */
      readonly needsInput: string
      /** Offline */
      readonly offline: string
      /** Offline · last seen {time} */
      readonly offlineSince: (args: { time: string }) => string
      /** Online */
      readonly online: string
      /** Working… */
      readonly working: string
    }
    readonly settings: {
      /** About */
      readonly about: string
      /** Account */
      readonly account: string
      /** Address */
      readonly address: string
      /** Appearance */
      readonly appearance: string
      /** Session token */
      readonly authModeToken: string
      readonly botNameOptions: {
        /** Display name */
        readonly display: string
        /** Profile name */
        readonly profile: string
      }
      /** Bot names */
      readonly botNames: string
      /** Which name is the large one. The profile name is what the rest of the app addresses a bot by; the display name is the label set on the gateway. A bot with on... */
      readonly botNamesHint: string
      /** What your bots can reach */
      readonly capabilityReach: string
      readonly categories: {
        /** About */
        readonly about: string
        /** Account */
        readonly account: string
        /** Advanced */
        readonly advanced: string
        /** Appearance */
        readonly appearance: string
        readonly blurb: {
          /** Which Hermie this is, and the licences it ships under. */
          readonly about: string
          /** Who this device is signed in as, and the ways of leaving. */
          readonly account: string
          /** Hermie Web’s own updates, and the tools for building the app. */
          readonly advanced: string
          /** Light or dark, the language, the text size and the theme. */
          readonly appearance: string
          /** The skills, servers and boards your bots can reach. */
          readonly capabilities: string
          /** What a new conversation shows, and how a bot is addressed. */
          readonly chats: string
          /** Which gateway this is, and how it is doing. */
          readonly gateway: string
          /** The gateway this device talks to, and the others it knows about. */
          readonly gateways: string
          /** What each bot remembers between conversations. */
          readonly memory: string
          /** When a bot may reach you, and how much a notification says. */
          readonly notifications: string
          /** The lock on this device, and what it takes to open it. */
          readonly privacy: string
          /** How Hermie reads a reply out, and how it hears you. */
          readonly voice: string
        }
        /** Bots & capabilities */
        readonly capabilities: string
        /** Chats & messages */
        readonly chats: string
        /** Gateway */
        readonly gateway: string
        /** Gateways */
        readonly gateways: string
        /** Memory */
        readonly memory: string
        /** Notifications */
        readonly notifications: string
        /** Privacy & security */
        readonly privacy: string
        readonly summary: {
          /** {count} bots */
          readonly bots: (args: { count: number }) => string
          /** Skills · MCP · Connectors */
          readonly capabilities: string
          /** Developer */
          readonly developer: string
          /** {host} */
          readonly gateway: (args: { host: string }) => string
          /** {host} · {count} gateways */
          readonly gateways: (args: { host: string; count: number }) => string
          /** Not in a browser */
          readonly lockBrowser: string
          /** On · {count} kinds */
          readonly notificationKinds: (args: { count: number }) => string
          /** Off */
          readonly off: string
          /** On */
          readonly on: string
          /** Not signed in */
          readonly signedOut: string
          /** Version {version} */
          readonly version: (args: { version: string }) => string
        }
        /** Voice */
        readonly voice: string
      }
      /** Change gateway */
      readonly changeGateway: string
      /** Forget this gateway and everything stored for it? */
      readonly changeGatewayConfirm: string
      /** Reopens setup with this address filled in. Nothing stored is dropped until a different gateway is applied. */
      readonly changeGatewayHint: string
      /** Chat */
      readonly chat: string
      /** Chat text size */
      readonly chatTextSize: string
      /** Applies to the words in a conversation, on top of the device’s own text size. The rest of the app follows the device. */
      readonly chatTextSizeHint: string
      /** Forget it */
      readonly confirm: string
      /** Connection test */
      readonly connectionTest: string
      /** Default verbosity */
      readonly defaultVerbosity: string
      /** How much of a bot’s working-out a new conversation shows. A conversation with its own setting keeps it. */
      readonly defaultVerbosityHint: string
      /** Developer */
      readonly developer: string
      /** Email */
      readonly email: string
      /** Forget this gateway */
      readonly forgetGateway: string
      /** Deletes the address and the credentials from this device and starts setup empty. */
      readonly forgetGatewayHint: string
      /** Gateway */
      readonly gateway: string
      readonly gateways: {
        /** Connected */
        readonly active: string
        /** Add gateway */
        readonly add: string
        /** Runs setup for another machine. The gateway currently open stays connected until you switch. */
        readonly addHint: string
        /** Session token */
        readonly authModeToken: string
        /** Gateways */
        readonly back: string
        /** Connect to this gateway */
        readonly connect: string
        /** Hermie disconnects from the gateway it is on and dials this one. */
        readonly connectHint: string
        /** Gateway */
        readonly detailTitle: string
        /** Gateways */
        readonly header: string
        /** Tap a gateway to connect to it. Hermie talks to one at a time; the others keep their conversations and their notifications. */
        readonly hint: string
        /** Keep it */
        readonly keepIt: string
        /** Manage */
        readonly manage: string
        /** Name */
        readonly name: string
        /** What this gateway is called on this device. It is not sent anywhere. */
        readonly nameHint: string
        /** Remove this gateway */
        readonly remove: string
        /** Remove this gateway and everything stored for it on this device? */
        readonly removeConfirm: string
        /** Remove it */
        readonly removeConfirmAction: string
        /** Forgets its address, its credentials, its conversations and its settings on this device. */
        readonly removeHint: string
        /** If this gateway is not the one Hermie is connected to, its notifications stop when it next tries to reach this device rather than straight away. */
        readonly removeNotifyNote: string
        /** Gateways */
        readonly row: string
        /** {count} gateways */
        readonly rowHint: (args: { count: number }) => string
        /** Save */
        readonly save: string
        /** Sign out of this gateway */
        readonly signOut: string
        /** Clears its stored credentials and keeps its address. */
        readonly signOutHint: string
        /** Signed in as {user} */
        readonly signedInAs: (args: { user: string }) => string
        /** Signed out */
        readonly signedOut: string
        /** Gateways */
        readonly title: string
        /** Use this gateway */
        readonly use: string
      }
      /** Hide profile name */
      readonly hideHandle: string
      /** When a bot has a display name, show only that — the profile name it is otherwise shown with drops off the second line. A bot with no display name keeps its o... */
      readonly hideHandleHint: string
      /** Host */
      readonly host: string
      /** Keep it */
      readonly keepIt: string
      /** Language */
      readonly language: string
      /** Follow device */
      readonly languageFollowDevice: string
      /** Hermie is written in English. Dutch and German are translations of it, and anything not yet translated stays in English. */
      readonly languageHint: string
      /** Licences */
      readonly licences: string
      /** Back to settings */
      readonly licencesBack: string
      /** The licence list could not be loaded: {message} */
      readonly licencesFailed: (args: { message: string }) => string
      /** Generated by {script}, alongside THIRD_PARTY_LICENSES.md. */
      readonly licencesGeneratedBy: (args: { script: string }) => string
      /** The open-source packages Hermie is built from, and what each one asks for. */
      readonly licencesHint: string
      /** Loading the licences… */
      readonly licencesLoading: string
      /** This package ships no licence file. The identifier above is everything it declares. */
      readonly licencesNoText: string
      /** Try again */
      readonly licencesRetry: string
      /** Production dependencies only; development tooling and Hermie's own {excluded} workspace packages are not in the list. */
      readonly licencesScope: (args: { excluded: number }) => string
      /** {count} packages ship inside Hermie. Tap one to read its licence. */
      readonly licencesSummary: (args: { count: number }) => string
      /** no licence declared */
      readonly licencesUndeclared: string
      readonly lock: {
        /** Ask for Face ID, Touch ID or this device’s passcode before Hermie can be read. This setting stays on this device. */
        readonly hint: string
        /** Hermie asks again after it has been away for this long, and always after it has been started fresh. This setting stays on this device. */
        readonly hintOn: string
        /** Require unlock */
        readonly label: string
        /** Set up a passcode, Face ID or a fingerprint in your device settings first — otherwise Hermie would lock with no way to open it. */
        readonly noEnrolment: string
        readonly options: {
          /** 15 min */
          readonly "15m": string
          /** 1 min */
          readonly "1m": string
          /** 5 min */
          readonly "5m": string
          /** Now */
          readonly immediately: string
          /** Off */
          readonly off: string
        }
        /** No biometrics are enrolled, so Hermie will ask for this device’s passcode. */
        readonly passcodeOnly: string
        /** Hermie could not confirm it was you, so nothing changed. Choose the option again to try once more. */
        readonly refused: string
        /** This device has no unlock method Hermie can ask for. */
        readonly unavailable: string
        /** Hermie cannot lock itself in a browser: the page and anything enforcing a lock are the same code. Lock the screen or close the tab. */
        readonly web: string
      }
      readonly notifications: {
        /** Notifications are turned off for Hermie in your device settings. Turn them on there first. */
        readonly denied: string
        /** Notifications */
        readonly enabled: string
        /** The Hermie plugin runs inside your gateway and sends a notification when a bot has news. Hermie Web with --push does the same job from outside, if a plugin c... */
        readonly enabledHint: string
        /** Notifications */
        readonly header: string
        /** Open Notifications settings */
        readonly openSystemSettings: string
        /** Hermie stays switched on here and registers as soon as macOS allows it. */
        readonly openSystemSettingsHint: string
        /** Show a preview */
        readonly preview: string
        /** Off, a notification says which bot and what happened. On, it carries the message as well — and a lock screen is where it will be read. */
        readonly previewHint: string
        /** Retry */
        readonly retry: string
        /** Asks for permission again and re-requests a push token. */
        readonly retryHint: string
        /** Registration */
        readonly status: string
        /** Permission denied. Turn notifications on for Hermie in your device settings. */
        readonly statusDenied: string
        /** Token request failed: {message} */
        readonly statusFailed: (args: { message: string }) => string
        /** This build has no EAS project id, so it cannot be given a push token. It needs rebuilding. */
        readonly statusNoProject: string
        /** Off. This device is not registered. */
        readonly statusOff: string
        /** Asking the platform for an address… */
        readonly statusPending: string
        /** Registered · …{tail} */
        readonly statusRegistered: (args: { tail: string }) => string
        /** Turn on notifications for Hermie in System Settings → Notifications */
        readonly statusSystemSettings: string
        /** This device cannot register: {detail} */
        readonly statusUnsupported: (args: { detail: string }) => string
        /** Routines */
        readonly typeCron: string
        /** A routine finished */
        readonly typeCronDone: string
        /** A routine failed */
        readonly typeCronFailed: string
        /** New message */
        readonly typeMessage: string
        /** Needs input */
        readonly typeRequest: string
        /** Finished working */
        readonly typeTurnDone: string
        /** Something went wrong */
        readonly typeTurnFailed: string
        /** Tell me about */
        readonly types: string
        /** A bot answering, a bot asking permission, a routine’s delivery, how a scheduled run ended, and a long task reaching its end either way. A turn you stopped yo... */
        readonly typesHint: string
        /** This device cannot register for notifications. Nothing has been sent. */
        readonly unavailable: string
        /** The browser only offers notifications when Hermie Web is served over https. */
        readonly webInsecure: string
      }
      /** Plugin */
      readonly plugin: string
      /** Not installed */
      readonly pluginAbsent: string
      /** Hermie plugin {version} */
      readonly pluginInstalled: (args: { version: string }) => string
      /** Checking… */
      readonly pluginUnknown: string
      /** Port */
      readonly port: string
      /** THEME */
      readonly preset: string
      /** Each theme has a light and a dark face; the setting above picks which one is showing. */
      readonly presetHint: string
      readonly presetOptions: {
        /** Blue */
        readonly blue: string
        /** Graphite */
        readonly graphite: string
        /** Lime */
        readonly lime: string
      }
      /** PRIVACY & SECURITY */
      readonly privacy: string
      /** Provider */
      readonly provider: string
      /** Scheme */
      readonly scheme: string
      readonly search: {
        /** Search settings */
        readonly label: string
        /** No setting matches that. */
        readonly noMatches: string
      }
      /** Show bot-to-bot */
      readonly showBotToBot: string
      /** Show thinking */
      readonly showThinking: string
      /** Sign out */
      readonly signOut: string
      /** Clears the stored credentials and keeps the gateway address. */
      readonly signOutHint: string
      /** Status */
      readonly status: string
      /** Theme */
      readonly theme: string
      /** System follows the device; Light and Dark pin the app either way. */
      readonly themeHint: string
      readonly themeOptions: {
        /** Dark */
        readonly dark: string
        /** Light */
        readonly light: string
        /** System */
        readonly system: string
      }
      readonly themes: {
        /** Your bubbles */
        readonly accentBubble: string
        /** Accent */
        readonly accentFill: string
        /** Back to settings */
        readonly back: string
        /** Background */
        readonly background: string
        /** #RRGGBB */
        readonly colourPlaceholder: string
        /** New theme */
        readonly create: string
        /** From {preset} */
        readonly createFrom: (args: { preset: string }) => string
        /** Delete */
        readonly delete: string
        /** Delete “{name}”? */
        readonly deleteConfirm: (args: { name: string }) => string
        /** The theme is removed everywhere this gateway is signed in. */
        readonly deleteHint: string
        /** Edit theme */
        readonly editPageTitle: string
        /** Editing the {scheme} face */
        readonly editing: (args: { scheme: string }) => string
        /** Switch the setting above to edit the other face. */
        readonly editingHint: string
        /** No themes of your own yet. Start one from a preset and edit its colours. */
        readonly empty: string
        /** Follow the preset */
        readonly followPreset: string
        /** YOUR THEMES */
        readonly header: string
        /** Keep it */
        readonly keepIt: string
        /** Name */
        readonly name: string
        /** Theme name */
        readonly namePlaceholder: string
        /** it measures {ratio} : 1 against the surface behind it, and a mark needs 3 : 1. */
        readonly reasonAccentFill: (args: { ratio: string }) => string
        /** the app’s text on it measures {ratio} : 1, and needs 4.5 : 1. */
        readonly reasonBackground: (args: { ratio: string }) => string
        /** white text on it measures {ratio} : 1, and needs 4.5 : 1. */
        readonly reasonBubble: (args: { ratio: string }) => string
        /** a colour is six hex digits after a #. */
        readonly reasonMalformed: string
        /** That colour is not used: {reason} */
        readonly rejected: (args: { reason: string }) => string
        /** Rename */
        readonly rename: string
        /** Themes */
        readonly title: string
        /** Untitled theme */
        readonly untitled: string
      }
      /** Settings */
      readonly title: string
      /** Unknown */
      readonly unknown: string
      /** Signed in as */
      readonly user: string
      /** Version */
      readonly version: string
      /** via Hermie Web */
      readonly viaHermieWeb: string
      readonly webUpdate: {
        /** Update */
        readonly apply: string
        /** {version} available */
        readonly available: (args: { version: string }) => string
        /** Checking… */
        readonly checking: string
        /** The update failed: {reason} */
        readonly failed: (args: { reason: string }) => string
        /** Hermie Web */
        readonly header: string
        /** Sign in to the gateway before updating Hermie Web. */
        readonly needsSignIn: string
        /** Hermie Web did not come back within a minute. Check its logs. */
        readonly restartTimedOut: string
        /** Restarting… */
        readonly restarting: string
        /** Running */
        readonly running: string
        /** Update */
        readonly state: string
        /** Up to date */
        readonly upToDate: string
        /** Downloading and installing… */
        readonly updating: string
      }
    }
    readonly share: {
      /** This may already have been sent to {bot}. Send it again, or discard it. */
      readonly maybeSent: (args: { bot: string }) => string
      /** This gateway has no bots to send to yet. */
      readonly noBots: string
      /** Note */
      readonly noteLabel: string
      /** Add a note (optional) */
      readonly notePlaceholder: string
      /** Send */
      readonly send: string
      /** Send again */
      readonly sendAgain: string
      /** Sending… */
      readonly sending: string
      /** Sent to {bot} */
      readonly sentTo: (args: { bot: string }) => string
      /** Send to a chat */
      readonly sheetTitle: string
      /** Will send when Hermie opens */
      readonly willSendLater: string
    }
    readonly sidebar: {
      /** Hermie Web {version} */
      readonly hermieWeb: (args: { version: string }) => string
    }
    readonly signedOut: {
      /** Your session on {host} has expired, so Hermie cannot reach your bots until you sign in. */
      readonly body: (args: { host: string }) => string
      /** Your session has expired, so Hermie cannot reach your bots until you sign in. */
      readonly bodyNoHost: string
      /** Change gateway */
      readonly changeGateway: string
      /** Showing the last saved list. */
      readonly listNote: string
      readonly reason: {
        /** There was nothing saved to renew the session with. */
        readonly noRefreshToken: string
        /** Renewing the session did not complete, so Hermie could not stay signed in. */
        readonly refreshFailed: string
        /** The gateway rejected the saved sign-in, so the session could not be renewed. */
        readonly refreshRejected: string
        /** The gateway rejected the sign-in Hermie had just renewed. */
        readonly rejectedAfterRefresh: string
        /** Hermie could not read the saved sign-in from the keychain. */
        readonly tokenUnreadable: string
      }
      /** Sign in */
      readonly signIn: string
      readonly stopped: {
        /** Opens setup with this address filled in. Your sign-in is kept until a different gateway is applied. */
        readonly changeGatewayHint: string
        /** This page is served by Hermie Web, which decides the gateway. Change it where that server is configured. */
        readonly fixedByServer: string
        /** Gateway */
        readonly gateway: string
        readonly hints: {
          /** If the gateway moved, change the address stored here to the one it publishes as its public URL. */
          readonly config: string
          /** Re-check reclaims the connection once the other client has let go. */
          readonly takenOver: string
        }
        /** Not signed in */
        readonly notSignedIn: string
        /** {name} */
        readonly onGateway: (args: { name: string }) => string
        /** OTHER GATEWAYS */
        readonly others: string
        /** Hermie talks to one gateway at a time. This one keeps its conversations. */
        readonly othersHint: string
        /** Re-check */
        readonly recheck: string
        /** Checking… */
        readonly rechecking: string
        /** Sign out */
        readonly signOut: string
        /** Connect to {name} */
        readonly switchTo: (args: { name: string }) => string
        readonly titles: {
          /** Signed out */
          readonly auth: string
          /** Chat is switched off on this gateway */
          readonly chatOff: string
          /** This gateway refused the connection */
          readonly config: string
          /** This gateway is too old */
          readonly incompatible: string
          /** This address is not a Hermes gateway */
          readonly not_hermes: string
          /** This gateway answered in a way Hermie cannot read */
          readonly protocol: string
          /** This address leads somewhere else */
          readonly redirect: string
          /** Another client took this connection over */
          readonly takenOver: string
          /** This gateway’s certificate was rejected */
          readonly tls: string
        }
      }
      /** Signed out */
      readonly title: string
    }
    readonly tabs: {
      /** Activity */
      readonly activity: string
      /** Chats */
      readonly chats: string
      /** Crons */
      readonly routines: string
      /** Settings */
      readonly settings: string
    }
    readonly transport: {
      /** Found over http:// */
      readonly foundOverHttp: string
      /** Found over https:// */
      readonly foundOverHttps: string
      /** Plain http:// to a public address. Anyone on the path can read your messages and your sign-in. Use https://, or reach the gateway over a private network such... */
      readonly httpExposed: string
      /** Plain http://, to an address on a local network. It is not reachable from outside that network. */
      readonly httpLocalNetwork: string
      /** Plain http://, and this connection never leaves this machine. */
      readonly httpLoopback: string
      /** Plain http://, over a tailnet address. WireGuard has already encrypted the path between this device and the gateway. */
      readonly httpTailnet: string
      /** Use https instead */
      readonly useHttps: string
    }
  }
  readonly botRename: {
    /** Leave it empty to fall back to the name the gateway reports. */
    readonly clearHint: string
    /** The default profile needs a name. */
    readonly clearRefused: string
    /** Stored in Hermie only; the gateway plugin is too old to save it on the gateway. */
    readonly displayAppOnly: string
    /** This gateway account may not change profile names. */
    readonly displayForbidden: string
    /** What Hermie calls this bot in your list. The gateway keeps the profile’s own name. */
    readonly displayHint: string
    /** Display name */
    readonly displayLabel: string
    /** That name could not be saved. */
    readonly failed: string
    /** The gateway has no profile called {name}. */
    readonly missing: (args: { name: string }) => string
    /** The gateway renamed this bot, but {parts|list(" and ", " and ")} could not be moved across. Reconnect to pick it up. */
    readonly partial: (args: { parts: readonly string[] }) => string
    /** the cached transcript */
    readonly partialCache: string
    /** the open chats */
    readonly partialStores: string
    /** Not set */
    readonly placeholder: string
    /** The name the rest of the app addresses this bot by. */
    readonly profileHint: string
    /** Profile name */
    readonly profileLabel: string
    /** Renaming changes the profile name other tools use */
    readonly profileWarning: string
    /** The gateway would not take that name. */
    readonly refused: string
    /** Rename profile */
    readonly renameAction: string
    /** Renaming… */
    readonly renameBusy: string
    /** Keep it as it is */
    readonly renameCancel: string
    /** The default profile keeps its name. Its home is the gateway’s own directory. */
    readonly renameDefault: string
    /** New profile name */
    readonly renameField: string
    /** Changes the profile on the gateway itself, not what Hermie shows. */
    readonly renameHint: string
    /** Rename profile… */
    readonly renameRow: string
  }
  readonly chat: {
    readonly approval: {
      /** Answered: {choice} */
      readonly answered: (args: { choice: string }) => string
      /** Answered elsewhere */
      readonly answeredElsewhere: string
      readonly choices: {
        /** Always allow */
        readonly always: string
        /** Deny */
        readonly deny: string
        /** Allow once */
        readonly once: string
        /** Allow for this session */
        readonly session: string
        /** An entry for a key that arrives at run time, or undefined for one this table does not have. */
        readonly [key: string]: string | undefined
      }
      /** PERMISSION REQUEST · @{handle|upper} */
      readonly eyebrow: (args: { handle: string }) => string
      /** Always allow applies to this exact command on this gateway. Change it later in Settings. */
      readonly fine: string
      /** @{handle} wants to run one command on your gateway host, in {directory}. */
      readonly lead: (args: { handle: string; directory?: string }) => string
      readonly outcomes: {
        /** Always allowed */
        readonly always: string
        /** Denied */
        readonly deny: string
        /** Allowed once */
        readonly once: string
        /** Allowed for the session */
        readonly session: string
        /** An entry for a key that arrives at run time, or undefined for one this table does not have. */
        readonly [key: string]: string | undefined
      }
      /** Runs on your gateway */
      readonly runsOn: string
      /** Timed out */
      readonly timedOut: string
      /** Allow this command? */
      readonly title: string
    }
    readonly assistant: {
      /** Something went wrong */
      readonly errorTitle: string
      /** {parts|list(" · ", " · ")} */
      readonly footer: (args: { parts: readonly string[] }) => string
      /** Interim note */
      readonly interim: string
      /** Reconnecting… */
      readonly reconnecting: string
      /** Reply to @{handle} */
      readonly replyTo: (args: { handle: string }) => string
      /** Retry */
      readonly retry: string
      /** Thinking */
      readonly thinking: string
      /** Thought for {seconds}s */
      readonly thoughtFor: (args: { seconds: number }) => string
      /** {input} in · {output} out */
      readonly tokens: (args: { input: string; output: string }) => string
    }
    readonly botDm: {
      /** Ambiguous target */
      readonly ambiguous: string
      /** ↩︎ answered */
      readonly answered: string
      /** From @{handle} */
      readonly asideFrom: (args: { handle: string }) => string
      /** To @{handle} */
      readonly asideTo: (args: { handle: string }) => string
      /** Message to {target} */
      readonly chip: (args: { target: string }) => string
      /** Delivered ✓ */
      readonly delivered: string
      /** Failed */
      readonly failed: string
      /** Message from {name} */
      readonly inChip: (args: { name: string }) => string
      readonly marker: {
        /** Failed */
        readonly failed: string
        /** ↩︎ replied */
        readonly replied: string
        /** Delivered · waiting for reply */
        readonly waiting: string
      }
      /** Open @{handle}’s chat */
      readonly openChat: (args: { handle: string }) => string
      /** Opens the chat with {name} */
      readonly openSender: (args: { name: string }) => string
      /** Opens the chat with {target} */
      readonly openTarget: (args: { target: string }) => string
      /** Queued · waiting for the current task */
      readonly queued: string
      /** {name} replied */
      readonly replied: (args: { name: string }) => string
      /** Reply */
      readonly reply: string
      /** {count} messages with @{handle} · {replies} replies */
      readonly rollup: (args: { count: number; handle: string; replies: number }) => string
      /** {count} messages · {replies} replies */
      readonly rollupMixed: (args: { count: number; replies: number }) => string
      /** Sending… */
      readonly sending: string
      /** Show less */
      readonly showLess: string
      /** Show more */
      readonly showMore: string
      /** @{handle} is writing… */
      readonly targetTyping: (args: { handle: string }) => string
      /** → {target} */
      readonly to: (args: { target: string }) => string
      /** Sent */
      readonly unknown: string
    }
    readonly clarify: {
      /** A QUESTION FOR YOU */
      readonly eyebrow: string
      /** Or answer in your own words */
      readonly freeText: string
      /** Type an answer… */
      readonly freeTextPlaceholder: string
      /** Later */
      readonly later: string
      /** Lock answer */
      readonly lock: string
      /** Locked */
      readonly locked: string
      /** Choose as many as apply */
      readonly multiSelectHint: string
      /** Next */
      readonly next: string
      /** Answered {answered} of {total} */
      readonly outcome: (args: { answered: number; total: number }) => string
      /** Back */
      readonly previous: string
      /** Question {current} of {total} */
      readonly step: (args: { current: number; total: number }) => string
      /** Submit */
      readonly submit: string
      /** Before I continue */
      readonly title: string
    }
    readonly composer: {
      /** Add attachment */
      readonly attach: string
      /** Choose file */
      readonly chooseFile: string
      /** Dismiss attachment menu */
      readonly dismissAttach: string
      /** Enter to send · Shift+Enter for a new line */
      readonly keyHint: string
      /** Message {bot} */
      readonly messageTo: (args: { bot: string }) => string
      /** Not sent yet */
      readonly notSentYet: string
      /** {count} files */
      readonly pendingCount: (args: { count: number }) => string
      /** Photo library */
      readonly photoLibrary: string
      /** Message */
      readonly placeholder: string
      /** ↳ 1 message queued · “{text}” */
      readonly queued: (args: { text: string }) => string
      /** Remove attachment */
      readonly removeAttachment: string
      /** Send message */
      readonly send: string
      /** Send message with {count} attachments */
      readonly sendWithAttachments: (args: { count: number }) => string
      /** Commands */
      readonly slashHint: string
      /** Loading… */
      readonly slashLoading: string
      /** Commands unavailable — {method} */
      readonly slashUnavailable: (args: { method: string }) => string
      /** Stop response */
      readonly stop: string
    }
    readonly context: {
      /** {used} / {limit} */
      readonly counts: (args: { used: string; limit: string }) => string
      /** (estimated) */
      readonly estimated: string
      /** How much of this session’s context window the conversation fills. */
      readonly hint: string
      /** Context used */
      readonly label: string
      /** {percent}% */
      readonly percent: (args: { percent: number }) => string
    }
    readonly conversations: {
      /** All conversations */
      readonly allConversations: string
      /** Conversations */
      readonly columnTitle: string
      /** My chat */
      readonly firstChat: string
      /** Group chat */
      readonly groupChat: string
      /** Hide conversations */
      readonly hideColumn: string
      /** New chat */
      readonly newChat: string
      /** The gateway would not start a new chat. */
      readonly newChatFailed: string
      /** This conversation could not be opened. */
      readonly openFailed: string
      /** Chat name */
      readonly renameLabel: string
      /** Show conversations */
      readonly showColumn: string
      /** Your chats */
      readonly yourChats: string
      /** Start a chat of your own to see it here. */
      readonly yoursEmpty: string
    }
    readonly cron: {
      /** delivered to this chat */
      readonly delivered: string
      /** The job delivered nothing to show. */
      readonly emptyBody: string
      /** CRON */
      readonly eyebrow: string
      /** Open cron */
      readonly open: string
      /** ran {time} · delivered to this chat */
      readonly ranAt: (args: { time: string }) => string
      /** Run now */
      readonly runNow: string
      /** Scheduled job */
      readonly unnamed: string
    }
    readonly drop: {
      /** Drop file to attach */
      readonly invitation: string
      /** Drop files here to attach them */
      readonly region: string
    }
    readonly export: {
      /** Download as Markdown */
      readonly downloadMarkdown: string
      /** Download as plain text */
      readonly downloadText: string
      /** The conversation could not be exported. */
      readonly failed: string
      /** Export */
      readonly header: string
      /** The conversation as it is on screen, with whatever this chat’s view settings hide left out. */
      readonly hint: string
      /** You */
      readonly self: string
      /** Share as Markdown */
      readonly shareMarkdown: string
      /** Share as plain text */
      readonly shareText: string
    }
    readonly fold: {
      /** Show less */
      readonly less: string
      /** Show more */
      readonly more: string
    }
    readonly header: {
      /** Back to chats */
      readonly back: string
      /** Hide sidebar */
      readonly hideSidebar: string
      /** Online */
      readonly idle: string
      /** Waiting for you */
      readonly needsInput: string
      /** Offline */
      readonly offline: string
      /** Offline · last seen {time} */
      readonly offlineAt: (args: { time: string }) => string
      /** Chat options */
      readonly options: string
      /** {name} — profile */
      readonly profile: (args: { name: string }) => string
      /** Running */
      readonly running: string
    }
    readonly menu: {
      /** Copy link */
      readonly copyLink: string
      /** Copy as Markdown */
      readonly copyMarkdown: string
      /** Copy text */
      readonly copyText: string
      /** Edit and resend */
      readonly editResend: string
      /** Hide details */
      readonly hideDetails: string
      /** Message actions */
      readonly message: string
      /** There is no message here to send again. */
      readonly nothingToRegenerate: string
      /** Open @{handle}’s chat */
      readonly openBotChat: (args: { handle: string }) => string
      /** Read aloud */
      readonly readAloud: string
      /** Regenerate */
      readonly regenerate: string
      /** Select text */
      readonly selectText: string
      /** Show details */
      readonly showDetails: string
      /** Stop reading */
      readonly stopReading: string
      /** Wait for the current turn to finish. */
      readonly turnRunning: string
    }
    readonly notifications: {
      /** Following the types set in Settings. */
      readonly following: string
      /** These override the global types in Settings for this chat only. */
      readonly hint: string
      /** Notifications */
      readonly label: string
      /** This chat has its own types. */
      readonly overridden: string
      /** What {bot} may notify you about */
      readonly subtitle: (args: { bot: string }) => string
      /** Notifications */
      readonly title: string
      readonly types: {
        /** Scheduled runs */
        readonly cron: string
        /** A scheduled run finished */
        readonly cronDone: string
        /** A scheduled run failed */
        readonly cronFailed: string
        /** Needs your answer */
        readonly needsInput: string
        /** Finished a turn */
        readonly turnDone: string
        /** A turn failed */
        readonly turnFailed: string
        /** An entry for a key that arrives at run time, or undefined for one this table does not have. */
        readonly [key: string]: string | undefined
      }
      /** Use the global types */
      readonly useDefault: string
    }
    readonly options: {
      /** Cancel */
      readonly cancel: string
      /** Tints this chat’s avatar ring, its row in the list and the messages you send. */
      readonly colourHint: string
      /** Done */
      readonly done: string
      /** Use it anyway */
      readonly expensiveConfirm: string
      /** This model costs more */
      readonly expensiveTitle: string
      /** This chat */
      readonly eyebrow: string
      /** Fast mode */
      readonly fast: string
      /** Prioritize response speed */
      readonly fastHint: string
      /** How it answers */
      readonly howHeader: string
      /** Model */
      readonly model: string
      /** Search models */
      readonly modelSearch: string
      /** Off */
      readonly notMuted: string
      /** Reasoning effort */
      readonly reasoning: string
      /** Show bot-to-bot */
      readonly showBotToBot: string
      /** Show thinking */
      readonly showThinking: string
      /** For this conversation with {bot} */
      readonly subtitle: (args: { bot: string }) => string
      /** Chat text size */
      readonly textSize: string
      readonly textSizes: {
        /** Default */
        readonly default: string
        /** Large */
        readonly large: string
        /** Small */
        readonly small: string
        /** Extra large */
        readonly xlarge: string
        /** An entry for a key that arrives at run time, or undefined for one this table does not have. */
        readonly [key: string]: string | undefined
      }
      /** This conversation */
      readonly thisChatHeader: string
      /** Chat options */
      readonly title: string
      /** Reset this conversation's view */
      readonly useDefault: string
      /** Clears this conversation's own verbosity and visibility settings and follows the default from Settings again. */
      readonly useDefaultHint: string
      /** Following the default set in Settings. */
      readonly usingDefault: string
      /** This conversation has its own view. */
      readonly usingOverride: string
      /** Verbosity */
      readonly verbosity: string
      readonly verbosityOptions: {
        /** Normal */
        readonly normal: string
        /** Quiet */
        readonly quiet: string
        /** Verbose */
        readonly verbose: string
      }
      /** What this conversation shows */
      readonly viewHeader: string
      /** YOLO mode */
      readonly yolo: string
      /** Skip approval requests */
      readonly yoloHint: string
    }
    readonly queue: {
      /** Delete */
      readonly delete: string
      /** Edit */
      readonly edit: string
      /** Queued */
      readonly label: string
      /** +{count} more */
      readonly more: (args: { count: number }) => string
      /** Steer */
      readonly steer: string
      /** Too late to steer — the turn was already finishing. It is back in the queue. */
      readonly steerRejected: string
      /** Handed to the running turn */
      readonly steered: string
      /** Steered */
      readonly steeredMarker: string
    }
    readonly receipt: {
      /** Delivered */
      readonly delivered: string
      /** Read */
      readonly read: string
      /** Sending… */
      readonly sending: string
      /** Sent */
      readonly sent: string
    }
    /** Replying */
    readonly replying: string
    readonly selectText: {
      /** Copy all */
      readonly copyAll: string
      /** Done */
      readonly done: string
      /** Drag to select · ⌘A all · ⌘C copy · Esc to close */
      readonly hint: string
      /** Message as selectable text */
      readonly panel: string
      /** Select text */
      readonly title: string
    }
    readonly sessions: {
      /** Make this the Bot Chat */
      readonly adopt: string
      /** The gateway would not make this the Bot Chat. */
      readonly adoptFailed: string
      /** back to main chat */
      readonly backToMain: string
      /** Branch from here… */
      readonly branch: string
      /** This conversation could not be branched. */
      readonly branchFailed: string
      /** Branched into {title}. */
      readonly branchMade: (args: { title: string }) => string
      /** Branch of {title} */
      readonly branchOf: (args: { title: string }) => string
      /** Branch */
      readonly branchTitle: string
      /** Branches */
      readonly branches: string
      /** Wait until the reply is finished or clear the queue first. */
      readonly busy: string
      /** Cancel */
      readonly cancel: string
      /** Current conversation */
      readonly canonical: string
      /** Conversations */
      readonly conversations: string
      /** Delete */
      readonly delete: string
      /** {title} will be removed from the gateway. This cannot be undone. */
      readonly deleteBody: (args: { title: string }) => string
      /** Delete */
      readonly deleteConfirm: string
      /** This conversation could not be deleted. */
      readonly deleteFailed: string
      /** Delete this conversation? */
      readonly deleteTitle: string
      /** This bot’s conversations could not be read. */
      readonly loadFailed: string
      /** Reading this bot’s conversations… */
      readonly loading: string
      /** {count} messages */
      readonly messages: (args: { count: number }) => string
      /** My chat */
      readonly mine: string
      /** My chat */
      readonly mineGroup: string
      /** Only you see this conversation. The bot keeps its own memory. */
      readonly mineNote: string
      /** Open */
      readonly open: string
      /** Open now */
      readonly openNow: string
      /** Past conversations */
      readonly past: string
      /** Nothing but the current conversation. */
      readonly pastEmpty: string
      /** Pin */
      readonly pin: string
      /** Refresh */
      readonly refresh: string
      /** This chat could not be refreshed. */
      readonly refreshFailed: string
      /** Rename */
      readonly rename: string
      /** This conversation could not be renamed. */
      readonly renameFailed: string
      /** Rename conversation */
      readonly renameTitle: string
      /** Retired */
      readonly retired: string
      /** Shared Bot Chat */
      readonly shared: string
      /** Everyone on this gateway shares this conversation. */
      readonly sharedNote: string
      /** This chat could not be switched. */
      readonly switchFailed: string
      /** Unpin */
      readonly unpin: string
      /** This conversation */
      readonly whose: string
    }
    readonly sheet: {
      /** Close */
      readonly close: string
    }
    readonly subagents: {
      /** {count} agents working */
      readonly barCount: (args: { count: number }) => string
      /** Show */
      readonly barOpen: string
      /** {count} goals */
      readonly goals: (args: { count: number }) => string
      readonly groupStatus: {
        /** Dispatched */
        readonly dispatched: string
        /** Done */
        readonly done: string
        /** Failed */
        readonly failed: string
        /** Running */
        readonly running: string
      }
      /** No agents running */
      readonly idle: string
      /** Open transcript */
      readonly openTranscript: string
      readonly status: {
        /** Done */
        readonly completed: string
        /** Failed */
        readonly failed: string
        /** Stopped */
        readonly interrupted: string
        /** Queued */
        readonly queued: string
        /** Running */
        readonly running: string
      }
      /** Steer */
      readonly steer: string
      /** Send a correction… */
      readonly steerPlaceholder: string
      /** Steer queued */
      readonly steerQueued: string
      /** Too late to steer — the agent had already finished its last batch. */
      readonly steerRejected: string
      /** Stop */
      readonly stop: string
      /** Stopping… */
      readonly stopped: string
      /** Agents */
      readonly title: string
      /** Back to the agents */
      readonly transcriptBack: string
      /** This agent has not written anything readable yet. */
      readonly transcriptEmpty: string
      /** Live tail · refreshing every few seconds */
      readonly transcriptLive: string
      /** The child’s own transcript, read-only. */
      readonly transcriptStored: string
      /** Transcript · {goal} */
      readonly transcriptTitle: (args: { goal: string }) => string
      /** {count} agents working · {elapsed} */
      readonly working: (args: { count: number; elapsed: string }) => string
    }
    readonly tool: {
      /** Arguments */
      readonly arguments: string
      /** Collapse tool call */
      readonly collapse: string
      /** Expand tool call */
      readonly expand: string
      /** Failed */
      readonly failed: string
      /** Preparing… */
      readonly generating: string
      /** No result recorded */
      readonly noResult: string
      /** Arguments (raw) */
      readonly rawArguments: string
      /** Result (raw) */
      readonly rawResult: string
      /** Redacted before it reached the model */
      readonly redacted: string
      /** Result */
      readonly result: string
      /** Untrusted output */
      readonly riskTitle: string
      /** Running… */
      readonly running: string
      /** Show less */
      readonly showLess: string
      /** Show more */
      readonly showMore: string
    }
    readonly transcript: {
      /** Answer */
      readonly answer: string
      /** answered */
      readonly answered: string
      /** No messages yet */
      readonly empty: string
      /** Jump to latest */
      readonly jumpToLatest: string
      /** Loading earlier… */
      readonly loadingEarlier: string
      /** {count} new */
      readonly newMessages: (args: { count: number }) => string
    }
    readonly viewer: {
      /** Close image */
      readonly close: string
      /** Download image */
      readonly download: string
      /** Opens the full-screen view */
      readonly openHint: string
      /** Share image */
      readonly share: string
    }
    readonly voice: {
      /** Read replies aloud */
      readonly autoRead: string
      /** Each finished reply in this chat, without being asked. */
      readonly autoReadHint: string
      /** Code block, {lines} lines */
      readonly codeBlock: (args: { lines: number }) => string
      /** Confirm before sending */
      readonly confirmBeforeSending: string
      /** Voice mode shows what it heard for a moment first. */
      readonly confirmBeforeSendingHint: string
      /** Dictate */
      readonly dictate: string
      /** Stop dictating */
      readonly dictateStop: string
      /** Device language */
      readonly dictationAuto: string
      /** Dictation language */
      readonly dictationLanguage: string
      /** Dictation stopped unexpectedly. */
      readonly failed: string
      /** VOICE */
      readonly header: string
      /** Listening… */
      readonly listening: string
      /** Voice mode */
      readonly mode: string
      /** Cancel */
      readonly modeCancel: string
      /** Swipe down to leave */
      readonly modeDismiss: string
      /** Tap to interrupt */
      readonly modeInterrupt: string
      /** Leave voice mode */
      readonly modeLeave: string
      /** Listening */
      readonly modeListening: string
      /** Sending */
      readonly modeSending: string
      /** Speaking */
      readonly modeSpeaking: string
      /** Start voice mode */
      readonly modeStart: string
      /** Waiting for a reply */
      readonly modeThinking: string
      /** Nothing was heard. */
      readonly noSpeech: string
      /** Open Settings */
      readonly openSettings: string
      /** Hermie needs the microphone to take dictation. */
      readonly permissionDenied: string
      /** Speaking rate */
      readonly rate: string
      readonly rateOptions: {
        /** Fast */
        readonly fast: string
        /** Fastest */
        readonly fastest: string
        /** Normal */
        readonly normal: string
        /** Slow */
        readonly slow: string
        /** Slowest */
        readonly slowest: string
      }
      /** Stop when the app closes */
      readonly stopOnBackground: string
      /** Dictation is not available on this device. */
      readonly unavailable: string
    }
  }
  readonly connectors: {
    /** Settings */
    readonly back: string
    /** Connect… */
    readonly connect: string
    /** The authorisation expired before it finished. */
    readonly connectExpired: string
    /** Could not connect: {reason} */
    readonly connectFailed: (args: { reason: string }) => string
    /** Opens your browser. Come back here when you have finished signing in. */
    readonly connectHint: string
    /** The gateway opened an authorisation but did not say where to send you. */
    readonly connectNoUrl: string
    /** {name} is connected. */
    readonly connectOk: (args: { name: string }) => string
    /** The authorisation was not completed. */
    readonly connectSkipped: string
    /** Waiting for the browser… */
    readonly connecting: string
    readonly detail: {
      /** Connectors */
      readonly back: string
      /** Enabled */
      readonly enabled: string
      /** No */
      readonly no: string
      /** Identifier */
      readonly slug: string
      /** Status */
      readonly status: string
      /** Connector */
      readonly title: string
      /** Yes */
      readonly yes: string
    }
    /** Signing out of a connector is done where you manage the account, not from Hermes. */
    readonly disconnect: string
    /** This gateway offers no connectors. */
    readonly empty: string
    /** Could not read the connectors: {reason} */
    readonly failed: (args: { reason: string }) => string
    /** Reading the connectors… */
    readonly loading: string
    /** Reason: {text} */
    readonly reason: (args: { text: string }) => string
    /** Reconnect… */
    readonly reconnect: string
    /** Refresh */
    readonly refresh: string
    readonly scope: {
      /** CHAT */
      readonly header: string
      /** Connectors belong to a chat. This page reads the one you pick. */
      readonly hint: string
      /** No chat is open. */
      readonly none: string
      /** Open a chat first — a connector list only exists for a running conversation. */
      readonly noneHint: string
    }
    readonly settings: {
      /** Apps a bot can reach on your behalf */
      readonly hint: string
      /** Connectors */
      readonly row: string
    }
    readonly state: {
      /** Connected */
      readonly connected: string
      /** Switched off */
      readonly disabled: string
      /** Not connected */
      readonly notConnected: string
      /** Unknown */
      readonly unknown: string
    }
    /** Apps your bots sign in to. */
    readonly subtitle: string
    /** Connectors */
    readonly title: string
    /** Connectors are switched off for this bot. */
    readonly unavailable: string
    /** Turn on the Connections toolset in the bot’s Capabilities, then come back. */
    readonly unavailableHint: string
  }
  readonly cron: {
    readonly confirmDelete: {
      /** The schedule is removed from the gateway. Run transcripts already recorded stay where they are. */
      readonly body: string
      /** Keep it */
      readonly cancel: string
      /** Delete */
      readonly confirm: string
      /** DELETE CRON */
      readonly eyebrow: string
      /** Delete “{name}”? */
      readonly title: (args: { name: string }) => string
    }
    readonly confirmRun: {
      /** The cron runs once, immediately, and delivers wherever it normally delivers. Its schedule is unchanged. */
      readonly body: string
      /** Cancel */
      readonly cancel: string
      /** Run now */
      readonly confirm: string
      /** RUN CRON */
      readonly eyebrow: string
      /** Run “{name}” now? */
      readonly title: (args: { name: string }) => string
    }
    readonly detail: {
      /** ACTIONS */
      readonly actions: string
      /** Crons */
      readonly back: string
      /** Delete cron */
      readonly delete: string
      /** Delivers to */
      readonly deliverLabel: string
      /** DETAILS */
      readonly details: string
      /** Edit */
      readonly edit: string
      /** Last error */
      readonly errorLabel: string
      /** Instructions */
      readonly instructions: string
      /** Last run */
      readonly lastRunLabel: string
      /** Last status */
      readonly lastStatusLabel: string
      /** Loading… */
      readonly loading: string
      /** Loading runs… */
      readonly loadingRuns: string
      /** Model */
      readonly modelLabel: string
      /** NEXT RUN */
      readonly nextRun: string
      /** This cron runs a script and has no prompt. */
      readonly noPrompt: string
      /** This cron has not run yet. */
      readonly noRuns: string
      /** Pause */
      readonly pause: string
      /** Paused because */
      readonly pausedReasonLabel: string
      /** Until removed */
      readonly repeatForever: string
      /** Repeat */
      readonly repeatLabel: string
      /** Resume */
      readonly resume: string
      /** RUN HISTORY */
      readonly runHistory: string
      /** Run now */
      readonly runNow: string
      /** Starting… */
      readonly running: string
      /** Could not load the run history: {reason} */
      readonly runsFailed: (args: { reason: string }) => string
      /** Schedule */
      readonly schedule: string
      /** Schedule */
      readonly scheduleLabel: string
      /** Skills */
      readonly skillsLabel: string
      /** State */
      readonly stateLabel: string
      /** — */
      readonly unknown: string
    }
    readonly editor: {
      /** Cancel */
      readonly cancel: string
      /** New cron */
      readonly createTitle: string
      /** Delivers to */
      readonly deliver: string
      /** Local (save only) */
      readonly deliverLocal: string
      /** Edit cron */
      readonly editTitle: string
      /** Name */
      readonly name: string
      /** Morning briefing */
      readonly namePlaceholder: string
      /** Give the cron a name. */
      readonly nameRequired: string
      /** The gateway decides the next run; it appears here once saved. */
      readonly nextRunHint: string
      /** Sends to the gateway as: {schedule} */
      readonly preview: (args: { schedule: string }) => string
      /** Profile */
      readonly profile: string
      /** This gateway */
      readonly profileDefault: string
      /** Whose cron store the job is written to. It runs as that bot. */
      readonly profileHint: string
      /** A cron cannot be moved to another profile after it is created. */
      readonly profileLocked: string
      /** Instructions */
      readonly prompt: string
      /** Summarize overnight updates and list three takeaways. */
      readonly promptPlaceholder: string
      /** Write the instructions the bot should follow. */
      readonly promptRequired: string
      /** Save cron */
      readonly save: string
      /** The gateway refused the cron: {reason} */
      readonly saveFailed: (args: { reason: string }) => string
      /** Saving… */
      readonly saving: string
      /** Schedule */
      readonly schedule: string
      /** What it does */
      readonly what: string
      /** Where it goes */
      readonly where: string
    }
    /** Crons will not run: the Hermes gateway process is not running */
    readonly gatewayBanner: string
    readonly list: {
      /** New cron */
      readonly add: string
      /** No crons yet. Create one to have a bot work while you are away. */
      readonly empty: string
      /** Could not load the crons: {reason} */
      readonly failed: (args: { reason: string }) => string
      /** last */
      readonly lastLabel: string
      /** Last run {when} */
      readonly lastRun: (args: { when: string }) => string
      /** Loading crons… */
      readonly loading: string
      /** Never run */
      readonly neverRun: string
      /** next */
      readonly nextLabel: string
      /** Next: {when} */
      readonly nextRun: (args: { when: string }) => string
      /** Not scheduled */
      readonly noNextRun: string
      /** Overdue */
      readonly overdue: string
      /** Profile: {name} */
      readonly profile: (args: { name: string }) => string
      /** Refreshed {when} */
      readonly refreshedAt: (args: { when: string }) => string
      /** Not refreshed yet */
      readonly refreshedNever: string
    }
    readonly relative: {
      /** {value}d ago */
      readonly daysAgo: (args: { value: number }) => string
      /** {value}h ago */
      readonly hoursAgo: (args: { value: number }) => string
      /** in {value}d */
      readonly inDays: (args: { value: number }) => string
      /** in {value}h */
      readonly inHours: (args: { value: number }) => string
      /** in {value} min */
      readonly inMinutes: (args: { value: number }) => string
      /** in {value}s */
      readonly inSeconds: (args: { value: number }) => string
      /** {value} min ago */
      readonly minutesAgo: (args: { value: number }) => string
      /** now */
      readonly now: string
      /** {value}s ago */
      readonly secondsAgo: (args: { value: number }) => string
    }
    readonly run: {
      /** Cron */
      readonly back: string
      /** This run recorded no messages. */
      readonly empty: string
      /** Could not load this run: {reason} */
      readonly failed: (args: { reason: string }) => string
      /** Loading the run… */
      readonly loading: string
      /** Read-only: a cron run cannot be continued from here. */
      readonly readOnly: string
      /** Run */
      readonly title: string
    }
    readonly schedule: {
      /** Cron expression */
      readonly cronExpression: string
      /** Five fields: minute, hour, day of month, month, day of week. */
      readonly cronHint: string
      /** 0 9 * * 1-5 */
      readonly cronPlaceholder: string
      /** Days */
      readonly days: string
      /** No day selected means every day. */
      readonly daysHint: string
      readonly errors: {
        /** The {field} field does not accept “{value}”. */
        readonly cronField: (args: { field: string; value: string }) => string
        /** A cron expression has five fields, for example 0 9 * * 1-5. */
        readonly cronFieldCount: string
        /** Enter how many minutes, hours or days between runs. */
        readonly interval: string
        /** Enter a delay such as “in 2h”, or a date and time such as 2026-09-20T09:00. */
        readonly once: string
        /** Enter a time as HH:MM, for example 09:00. */
        readonly time: string
      }
      /** Every */
      readonly everyLabel: string
      /** Repeat */
      readonly mode: string
      readonly modes: {
        /** Cron */
        readonly cron: string
        /** Daily */
        readonly daily: string
        /** Interval */
        readonly interval: string
        /** Once */
        readonly once: string
      }
      /** When */
      readonly once: string
      /** A delay such as “in 2h”, or a date and time such as 2026-09-20T09:00. */
      readonly onceHint: string
      /** in 2h */
      readonly oncePlaceholder: string
      /** Time */
      readonly time: string
      /** 09:00 */
      readonly timePlaceholder: string
      readonly units: {
        /** days */
        readonly days: string
        /** hours */
        readonly hours: string
        /** minutes */
        readonly minutes: string
      }
      /** S | M | T | W | T | F | S */
      readonly weekdayInitials: readonly string[]
      /** Sunday | Monday | Tuesday | Wednesday | Thursday | Friday | Saturday */
      readonly weekdayNames: readonly string[]
    }
    readonly sections: {
      /** ACTIVE */
      readonly active: string
      /** PAUSED */
      readonly paused: string
    }
    readonly status: {
      /** Failed */
      readonly failed: string
      /** Success */
      readonly ok: string
      /** Paused */
      readonly paused: string
      /** Waiting */
      readonly pending: string
      /** Running */
      readonly running: string
    }
    /** A little progress, on repeat. */
    readonly subtitle: string
    /** Crons */
    readonly title: string
  }
  readonly kanban: {
    /** This gateway has no Kanban plugin. */
    readonly absent: string
    /** hermes plugins install kanban */
    readonly absentCommand: string
    /** Install it on the machine that runs the gateway: */
    readonly absentHint: string
    /** Settings */
    readonly back: string
    readonly board: {
      /** Boards */
      readonly back: string
      /** Nothing here. */
      readonly columnEmpty: string
      /** Nothing on this board yet. */
      readonly empty: string
      /** Hide archived */
      readonly hideArchived: string
      /** Reading the board… */
      readonly loading: string
      /** New card */
      readonly newCard: string
      /** Show archived */
      readonly showArchived: string
    }
    /** {count} cards */
    readonly boardCards: (args: { count: number }) => string
    readonly card: {
      /** Archive */
      readonly archive: string
      /** Archiving keeps the card and its history. It is not a delete. */
      readonly archiveHint: string
      /** Archived. */
      readonly archived: string
      /** Archiving… */
      readonly archiving: string
      /** Assignee */
      readonly assignee: string
      /** Board */
      readonly back: string
      /** Notes */
      readonly body: string
      /** Column */
      readonly column: string
      /** Created */
      readonly created: string
      /** Priority */
      readonly priority: string
      /** Save */
      readonly save: string
      /** Saved. */
      readonly saved: string
      /** Saving… */
      readonly saving: string
      /** LATEST SUMMARY */
      readonly summary: string
      /** Title */
      readonly title: string
    }
    readonly columns: {
      /** Archived */
      readonly archived: string
      /** Blocked */
      readonly blocked: string
      /** Done */
      readonly done: string
      /** Ready */
      readonly ready: string
      /** Review */
      readonly review: string
      /** Running */
      readonly running: string
      /** Scheduled */
      readonly scheduled: string
      /** To do */
      readonly todo: string
      /** Triage */
      readonly triage: string
      /** An entry for a key that arrives at run time, or undefined for one this table does not have. */
      readonly [key: string]: string | undefined
    }
    readonly comments: {
      /** Comment */
      readonly add: string
      /** Posting… */
      readonly adding: string
      /** COMMENTS */
      readonly header: string
      /** No comments yet. */
      readonly none: string
      /** Add a comment */
      readonly placeholder: string
    }
    readonly create: {
      /** Notes */
      readonly bodyField: string
      /** COLUMN */
      readonly column: string
      /** A card needs a title. */
      readonly needsTitle: string
      /** Make the card */
      readonly submit: string
      /** Making it… */
      readonly submitting: string
      /** New card */
      readonly title: string
      /** Title */
      readonly titleField: string
      /** What needs doing */
      readonly titlePlaceholder: string
    }
    /** Hold a card to pick it up, then drop it on a column. */
    readonly dragHint: string
    /** Hold to pick this card up, or use Move to… */
    readonly dragLabel: string
    /** This gateway has no boards yet. */
    readonly empty: string
    /** Make one with `hermes kanban board create`, or from the Hermes desktop app. */
    readonly emptyHint: string
    /** Could not read the boards: {reason} */
    readonly failed: (args: { reason: string }) => string
    /** Reading the boards… */
    readonly loading: string
    /** Running, Review and Scheduled are the dispatcher’s. A card can leave them but not be put into them. */
    readonly locked: string
    /** {column} is the dispatcher’s. A card cannot be put there. */
    readonly lockedTarget: (args: { column: string }) => string
    /** Boards */
    readonly menu: string
    /** Move to… */
    readonly move: string
    /** {reason} */
    readonly moveRefused: (args: { reason: string }) => string
    /** Moved to {column}. */
    readonly moved: (args: { column: string }) => string
    /** Asked for {asked}; the board put it in {got}. */
    readonly movedElsewhere: (args: { asked: string; got: string }) => string
    /** Cards are ordered by priority and age, so there is no order to drag within a column. */
    readonly noOrder: string
    readonly settings: {
      /** The Kanban boards this gateway keeps */
      readonly hint: string
      /** Boards */
      readonly row: string
    }
    /** Work your bots pick up. */
    readonly subtitle: string
    /** Boards */
    readonly title: string
  }
  readonly mcp: {
    /** Authorise… */
    readonly authorise: string
    /** Authorisation did not finish: {reason} */
    readonly authoriseFailed: (args: { reason: string }) => string
    /** Opens your browser. Come back here when you have finished signing in. */
    readonly authoriseHint: string
    /** Authorised. */
    readonly authoriseOk: string
    /** Waiting for the browser… */
    readonly authorising: string
    /** Settings */
    readonly back: string
    readonly detail: {
      /** Address */
      readonly address: string
      /** Authentication */
      readonly auth: string
      /** None */
      readonly authNone: string
      /** MCP servers */
      readonly back: string
      /** ENVIRONMENT KEYS */
      readonly env: string
      /** The gateway never sends their values — only which keys this server expects. */
      readonly envHint: string
      /** MCP server */
      readonly title: string
      /** TOOLS */
      readonly tools: string
      /** This server offered no tools. */
      readonly toolsEmpty: string
      /** Test the connection to see what this server offers. */
      readonly toolsUnknown: string
      /** Transport */
      readonly transport: string
    }
    /** No MCP servers are configured on this gateway. */
    readonly empty: string
    /** Add one with `hermes mcp add`, or from the Hermes desktop app. */
    readonly emptyHint: string
    /** Could not read the servers: {reason} */
    readonly failed: (args: { reason: string }) => string
    /** Reading the server list… */
    readonly loading: string
    /** Needs authorising */
    readonly needsAuth: string
    /** Reload servers */
    readonly reload: string
    /** Applies configuration changes to chats that are already running. */
    readonly reloadHint: string
    readonly runtime: {
      /** Configured */
      readonly configured: string
      /** Connected */
      readonly connected: string
      /** Connecting… */
      readonly connecting: string
      /** Switched off */
      readonly disabled: string
      /** Not connected */
      readonly failed: string
      /** Starts when needed */
      readonly lazy: string
      /** Not started yet */
      readonly unknown: string
    }
    readonly settings: {
      /** Tools your bots reach over the Model Context Protocol */
      readonly hint: string
      /** MCP servers */
      readonly row: string
    }
    /** Tools your bots can reach. */
    readonly subtitle: string
    /** Test connection */
    readonly test: string
    /** Could not connect: {reason} */
    readonly testFailed: (args: { reason: string }) => string
    /** Connected. {count} tools available. */
    readonly testOk: (args: { count: number }) => string
    /** Connecting… */
    readonly testing: string
    /** MCP servers */
    readonly title: string
    /** {count} tools */
    readonly toolCount: (args: { count: number }) => string
  }
  readonly memory: {
    readonly add: {
      /** Add */
      readonly action: string
      /** Add to {target} */
      readonly label: (args: { target: string }) => string
      /** Write something down */
      readonly placeholder: string
    }
    /** No bots yet. */
    readonly botsEmpty: string
    /** Read and edit what each bot remembers. */
    readonly botsHint: string
    /** Memory */
    readonly botsTitle: string
    readonly edit: {
      /** Edit */
      readonly action: string
      /** Cancel */
      readonly cancel: string
      /** Edit entry {index|add(1)} */
      readonly label: (args: { index: number }) => string
      /** Replace */
      readonly save: string
    }
    readonly empty: {
      /** Nothing written down yet. */
      readonly memory: string
      /** Nothing written down about you yet. */
      readonly user: string
    }
    /** Could not read this memory: {reason} */
    readonly failed: (args: { reason: string }) => string
    /** {name}'s memory */
    readonly forBot: (args: { name: string }) => string
    readonly graph: {
      readonly detail: {
        /** Close */
        readonly close: string
        /** Entry */
        readonly entry: string
        /** No topics in this entry. */
        readonly noTopics: string
        /** Show in the list */
        readonly open: string
        /** This bot */
        readonly profile: string
        /** Topic */
        readonly topic: string
        /** MENTIONS */
        readonly topics: string
      }
      /** {count} more nodes were left out of the drawing. */
      readonly dropped: (args: { count: number }) => string
      /** Nothing to draw yet. */
      readonly empty: string
      readonly full: {
        /** Close */
        readonly close: string
        /** Close the graph */
        readonly dismiss: string
        /** Open full screen */
        readonly open: string
        /** Memory graph */
        readonly title: string
      }
      /** A map of this memory: the bot, its entries and the topics they share */
      readonly label: string
      /** Drawing… */
      readonly loading: string
      /** Reset */
      readonly reset: string
      /** Showing {shown} of {total} entries. The rest are not on this page of the map. */
      readonly truncated: (args: { shown: number; total: number }) => string
      /** Zoom in */
      readonly zoomIn: string
      /** Zoom out */
      readonly zoomOut: string
    }
    /** Reading memory… */
    readonly loading: string
    readonly missing: {
      /** Reading a bot’s memory needs the hermie plugin, version 0.5.0 or newer, installed on the gateway and enabled for this profile. */
      readonly body: string
      /** Read the guide */
      readonly guide: string
      /** ON THE GATEWAY */
      readonly install: string
      /** The Hermie plugin has no memory browser */
      readonly title: string
      /** Waiting for the gateway to say what is installed… */
      readonly unknown: string
    }
    readonly providers: {
      /** PROVIDERS */
      readonly header: string
      /** An external memory provider answers a bot with text for one turn. It offers no call that lists what it holds, so there is nothing here to show. */
      readonly hint: string
      /** Not browsable */
      readonly notBrowsable: string
    }
    readonly raw: {
      /** {chars} characters */
      readonly chars: (args: { chars: number }) => string
      /** This one is empty. */
      readonly emptyDocument: string
      /** Reading what each backend holds… */
      readonly loading: string
      /** This gateway’s Hermie plugin does not serve raw memory. */
      readonly missing: string
      /** hermes plugins install hermie */
      readonly missingCommand: string
      /** Update the plugin on the machine that runs the gateway: */
      readonly missingHint: string
      /** This gateway named no memory backends. */
      readonly none: string
      /** This backend cannot say what it holds. */
      readonly notListable: string
      /** Read-only. Entries are edited on the Entries tab. */
      readonly readOnly: string
      /** The gateway sent only the beginning of this one. */
      readonly truncated: string
      /** This backend is not available on this gateway. */
      readonly unavailable: string
    }
    /** This gateway lets memory be read and not written. Switch on the plugin’s memory.edit for this profile to change that. */
    readonly readOnly: string
    readonly remove: {
      /** Remove */
      readonly action: string
      /** Keep it */
      readonly cancel: string
      /** Remove */
      readonly confirm: string
      /** The bot stops being told this. Hermes keeps no history of a memory file. */
      readonly confirmBody: string
      /** Remove this entry? */
      readonly confirmTitle: string
      /** Remove entry {index|add(1)} */
      readonly label: (args: { index: number }) => string
    }
    /** Try again */
    readonly retry: string
    /** What this bot remembers about its work, and about you. */
    readonly rowHint: string
    /** Memory */
    readonly rowTitle: string
    readonly search: {
      /** Clear */
      readonly clear: string
      /** {found} entries */
      readonly count: (args: { found: number }) => string
      /** Every word has to appear somewhere in the entry. Order does not matter. */
      readonly hint: string
      /** Nothing matches “{query}”. */
      readonly none: (args: { query: string }) => string
      /** Search this memory */
      readonly placeholder: string
      /** Searching… */
      readonly searching: string
    }
    readonly sectionHint: {
      /** What the bot has written down about its work. Hermes' own MEMORY.md. */
      readonly memory: string
      /** What the bot has written down about you. USER.md. */
      readonly user: string
    }
    readonly sections: {
      /** MEMORY */
      readonly memory: string
      /** USER */
      readonly user: string
    }
    readonly tabs: {
      /** Entries */
      readonly entries: string
      /** Graph */
      readonly graph: string
      /** Raw */
      readonly raw: string
    }
    /** Memory */
    readonly title: string
    /** {chars} of {limit} characters */
    readonly usage: (args: { chars: number; limit: number }) => string
    /** {target} is {percent}% full */
    readonly usageLabel: (args: { target: string; percent: number }) => string
    /** {chars} characters */
    readonly usageUnbounded: (args: { chars: number }) => string
  }
  readonly profiles: {
    readonly capabilities: {
      /** Could not read the configuration: {reason} */
      readonly failed: (args: { reason: string }) => string
      /** Reading this bot’s configuration… */
      readonly loading: string
      /** Manage servers… */
      readonly manageMcp: string
      /** MCP SERVERS */
      readonly mcp: string
      /** No MCP servers configured on this gateway. */
      readonly mcpEmpty: string
      /** Switching a server on here makes its tools available to this bot. */
      readonly mcpFooter: string
      readonly reload: {
        /** Reload, and stop asking */
        readonly always: string
        /** Stops the gateway asking again — in the CLI and the desktop app too. */
        readonly alwaysHint: string
        /** MCP servers reload for every live chat. The next message in each one re-sends its full input. */
        readonly body: string
        /** MCP servers reloaded. */
        readonly done: string
        /** MCP reload */
        readonly eyebrow: string
        /** Could not reload: {reason} */
        readonly failed: (args: { reason: string }) => string
        /** Not now */
        readonly later: string
        /** Reload now */
        readonly now: string
        /** Apply to running chats? */
        readonly title: string
      }
      /** Capabilities */
      readonly row: string
      /** Skills, tools and MCP servers for this bot */
      readonly rowDetail: string
      /** The gateway refused the change: {reason} */
      readonly saveFailed: (args: { reason: string }) => string
      /** SKILLS */
      readonly skills: string
      /** No skills installed for this bot. */
      readonly skillsEmpty: string
      /** Skills are folders of instructions the bot can open when it needs them. */
      readonly skillsFooter: string
      /** Capabilities */
      readonly title: string
      /** {count} tools */
      readonly toolCount: (args: { count: number }) => string
      /** TOOLSETS */
      readonly toolsets: string
      /** Pinned for this bot. */
      readonly toolsetsPinned: string
      /** This bot follows the gateway’s defaults. Changing a switch pins the whole list. */
      readonly toolsetsUnpinned: string
    }
    readonly new: {
      /** Cancel */
      readonly cancel: string
      /** Clone settings from */
      readonly cloneFrom: string
      /** A clone copies the source bot’s skills, tools and MCP switches. Its messaging accounts are never copied — two bots cannot hold one Telegram token. */
      readonly cloneHint: string
      /** Start fresh */
      readonly cloneNone: string
      /** Create bot */
      readonly create: string
      /** Making the bot… */
      readonly creating: string
      /** Description */
      readonly description: string
      /** Looks things up before anyone asks. */
      readonly descriptionPlaceholder: string
      /** Display name */
      readonly displayName: string
      /** What Hermie shows in the list. Leave it blank to use the handle. */
      readonly displayNameHint: string
      /** Scout */
      readonly displayNamePlaceholder: string
      /** A bot of your own */
      readonly eyebrow: string
      /** Could not make the bot: {reason} */
      readonly failed: (args: { reason: string }) => string
      /** Handle */
      readonly handle: string
      /** Lower case, no spaces. This is the name the gateway knows it by, and it cannot be changed later. */
      readonly handleHint: string
      /** scout */
      readonly handlePlaceholder: string
      /** Model */
      readonly model: string
      /** A new bot inherits the gateway’s own model unless you pin one here. */
      readonly modelHint: string
      /** Inherit from the launch bot */
      readonly modelInherit: string
      /** New bot */
      readonly title: string
      /** This bot has no model yet. Pick one in its profile before you write to it. */
      readonly withoutModel: string
    }
    readonly settings: {
      /** Bots */
      readonly group: string
      /** New bot… */
      readonly newBot: string
      /** Make another bot on this gateway */
      readonly newBotHint: string
    }
  }
  readonly skills: {
    /** Installed */
    readonly alreadyInstalled: string
    /** Settings */
    readonly back: string
    /** Bot */
    readonly botPicker: string
    /** CATALOGUE */
    readonly catalogue: string
    /** Nothing matched. */
    readonly catalogueEmpty: string
    /** This gateway cannot install skills over its socket. Run this on the machine that hosts it: */
    readonly cliOnly: string
    /** Could not read the skills: {reason} */
    readonly failed: (args: { reason: string }) => string
    /** Switches are for {name}. */
    readonly forBot: (args: { name: string }) => string
    /** Install */
    readonly install: string
    /** Could not install: {reason} */
    readonly installFailed: (args: { reason: string }) => string
    /** INSTALLED */
    readonly installed: string
    /** No skills installed yet. */
    readonly installedEmpty: string
    /** A skill is a folder of instructions a bot opens when it needs them. */
    readonly installedFooter: string
    /** Installed {name}. */
    readonly installed_: (args: { name: string }) => string
    /** Installing… */
    readonly installing: string
    /** Reading the skills… */
    readonly loading: string
    /** Pick a bot to switch skills on and off for it. */
    readonly noBot: string
    /** Search the hub */
    readonly search: string
    /** pdf, spreadsheets, video… */
    readonly searchPlaceholder: string
    /** Searching… */
    readonly searching: string
    readonly settings: {
      /** What your bots know how to do */
      readonly hint: string
      /** Skills */
      readonly row: string
    }
    /** Instructions your bots can open. */
    readonly subtitle: string
    /** Skills */
    readonly title: string
    /** Could not change that: {reason} */
    readonly toggleFailed: (args: { reason: string }) => string
  }
}

/**
 * The strings in the language the reader is using. Each read resolves when it is made,
 * so a screen that renders after a language switch says the new language.
 */
export const strings: Strings = createStrings<Strings>()
