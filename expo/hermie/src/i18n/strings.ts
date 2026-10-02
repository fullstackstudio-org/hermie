/**
 * Every user-visible string in one plain object.
 *
 * There is no i18n library yet and no locale negotiation: the app ships in
 * English. What this module buys today is a single place to read the app's
 * voice, and a seam that a real catalogue can slot into later without touching
 * a screen. Strings that interpolate are functions rather than templates with
 * placeholders, so the type checker catches a missing argument.
 *
 * The chat UI kit keeps its own copy in `src/chat-ui/strings.ts`. That is on
 * purpose and not an oversight: the kit is a self-contained set of components
 * with its own gallery, and a component that travels with its wording can be
 * lifted out without dragging this file along. Everything a SCREEN says lives
 * here; everything a KIT COMPONENT says lives there.
 */
import { localised } from './catalogue'

const list = (items: string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  const head = items.slice(0, -1).join(', ')

  return `${head} or ${items[items.length - 1]}`
}

const stringsEn = {
  app: {
    name: 'Hermie',
    loading: 'Starting…'
  },

  common: {
    back: 'Back',
    cancel: 'Cancel',
    continue: 'Continue',
    retry: 'Try again',
    signIn: 'Sign in',
    done: 'Done',
    add: 'Add',
    remove: 'Remove',
    openInBrowser: 'Open in browser instead',
    /** The generic label on a picker's own search field. */
    search: 'Search',
    /** A search that matched none of the options. */
    noMatches: 'Nothing matches that.',
    /** A picker whose list is empty before anybody typed anything. */
    nothingToPick: 'Nothing to choose from.',
    /**
     * The accessible name of a sheet's backdrop — the layer a tap anywhere
     * outside the panel lands on.
     *
     * In `common` rather than in the sheet kit because every sheet in the app
     * shares one backdrop, and because it was the string that proved the
     * tables were not the only place names come from: it was a literal in
     * `ui/BottomSheet.tsx`.
     */
    dismiss: 'Dismiss'
  },

  /**
   * The locked app, which says four things and deliberately not a fifth.
   *
   * No bot names, no counts, no "3 new messages": everything a lock screen
   * adds beyond "this is Hermie and it is locked" is something it has given
   * away. `features/lock/LockPlate.tsx` is built so it could not say more if
   * the copy asked it to.
   */
  lock: {
    /** The line the platform prints above its own Face ID / passcode prompt. */
    prompt: 'Unlock Hermie',
    plateBody: 'Hermie is locked.',
    unlock: 'Unlock',
    /**
     * The one case the plate has to explain rather than just ask.
     *
     * Reachable only by removing the device passcode after switching the lock
     * on — the setting refuses to go on without one — and from inside the
     * plate there is nothing to tap that would fix it.
     */
    stranded:
      'Hermie is locked, and this device has no passcode or biometric set up to unlock it. Add one in your device settings.'
  },

  onboarding: {
    stepCounter: (current: number, total: number) => `Step ${current} of ${total}`,

    welcome: {
      title: 'Welcome to Hermie',
      body: 'Hermie is a client for Hermes Agent. It talks to one gateway at a time — the machine running `hermes serve` — and chats with the bots that live there.',
      note: 'Nothing is stored until the connection has been tested.',
      action: 'Set up a gateway'
    },

    address: {
      title: 'Gateway address',
      subtitle: 'The address you would open in a browser to reach the gateway dashboard.',
      label: 'ADDRESS',
      placeholder: 'hermes.example.com',
      // The resolver really does try both, https first (`resolveGatewayAddress`
      // in packages/gateway-client). Until this said so, the behaviour existed
      // and nobody knew about it, so an address that only answers on http read
      // as a typo.
      hint: 'Leave the scheme out and Hermie tries https:// first, then http://. Type a scheme yourself to pin it.',
      advanced: 'Advanced',
      advancedHint:
        'Extra request headers are sent with every call and with the sign-in page. A reverse proxy that wants a shared secret needs it here.',

      /**
       * The Advanced preset picker, and the labelled fields behind one of them.
       *
       * The Cloudflare wording has one job beyond naming the fields: to say, up
       * front, the thing that only becomes visible as a 403 halfway through a
       * sign-in. A service token gets a request past the edge; it does not get
       * a BROWSER past it, and the sign-in page is a browser.
       */
      frontDoor: {
        label: 'IN FRONT OF THE GATEWAY',
        custom: 'Custom headers',
        cloudflare: 'Cloudflare Access',
        hint: 'Pick how the proxy in front of your gateway lets Hermie through. Nothing here is sent anywhere but the gateway’s own address.',
        clientId: 'Client ID',
        clientIdPlaceholder: 'abc123.access',
        clientSecret: 'Client Secret',
        cloudflareHint:
          'A service token from your Access application. Hermie sends it with every request, the WebSocket and the sign-in page. Exempt /auth/* and /login from the Access policy: a service token cannot carry a redirect-based sign-in through the edge.',
        /**
         * Said instead of the hint when the gateway is reached in the clear.
         *
         * A service token is a long-lived credential for a whole Access
         * tenant, and an http gateway is one this app supports on purpose
         * (ADR-0014). Rather than refuse either, the headers are withheld and
         * the reason is on screen — a silent withholding would surface as an
         * unexplained 403.
         */
        insecure:
          'This gateway is reached over http://, so the service token is not being sent — it is a long-lived credential for your whole Access tenant. Use https:// for the address the Access application covers.'
      },

      headerName: 'Header',
      headerValue: 'Value',
      addHeader: 'Add a header',
      showValue: 'Show value',
      hideValue: 'Hide value',
      removeHeader: (name: string) => `Remove the ${name || 'empty'} header`,
      probing: 'Checking…',
      /** Which scheme is in flight, so the wait is not a silent one. */
      probingScheme: (scheme: string) => `Checking ${scheme}…`,
      probingBoth: 'Checking https://, then http://…',
      signInRequired: (version: string, providers: string[]) =>
        `Hermes ${version || 'gateway'} · sign-in required via ${list(providers)}`,
      signInRequiredNoProviders: (version: string) =>
        `Hermes ${version || 'gateway'} · sign-in required, but this gateway lists no identity providers. Configure one on the gateway.`,
      sessionTokenRequired: (version: string) => `Hermes ${version || 'gateway'} · session token required`
    },

    signIn: {
      title: 'Sign in',
      subtitleNative:
        'The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device.',
      subtitleToken:
        'This gateway is not gated by an identity provider; it authenticates with the session token it prints at startup.',
      subtitleCookie:
        'The gateway hosts the sign-in page. Your browser keeps the session it hands back; Hermie never sees it.',
      chooseProvider: 'Provider',
      signInWith: (provider: string) => `Sign in with ${provider}`,
      signedInAs: (user: string) => `Signed in as ${user}`,
      signedIn: 'Signed in',
      signOutAndRetry: 'Sign in again',
      blockedTitle: 'This gateway is too old for native sign-in',
      blockedBody:
        'It requires a sign-in but does not advertise the native_pkce flow, which is the only one a mobile app can complete. Update Hermes on the gateway.',
      tokenLabel: 'SESSION TOKEN',
      tokenHelp: 'Paste the session token printed by `hermes serve`.',
      tokenPlaceholder: 'Session token',
      showToken: 'Show token',
      hideToken: 'Hide token',

      // Browser build only: the cookie flow.
      servedFrom: (host: string) => `Served by Hermie Web, talking to ${host}.`,
      servedFromUnknown: 'Served by Hermie Web.',
      probingGateway: 'Reading the gateway…',
      checkingSession: 'Checking whether you are already signed in…',
      leavingForProvider: 'Taking you to the sign-in page…',
      passwordUser: 'USER NAME',
      passwordSecret: 'PASSWORD',
      /*
       * The same two fields, said quietly, for the accessible name.
       *
       * Section headers in this app are written in capitals and the sign-in
       * form follows them, which is right on screen and wrong in an ear: a
       * screen reader given a control named `USER NAME` either shouts it or
       * spells it out a letter at a time. These are what the fields are CALLED;
       * the pair above is what is drawn.
       */
      passwordUserLabel: 'User name',
      passwordSecretLabel: 'Password',
      passwordSubmit: 'Sign in',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      cookieBlockedTitle: 'This gateway is too old for browser sign-in',
      cookieBlockedBody:
        'It requires a sign-in but does not advertise the cookie flow, which is the only one a browser tab can complete. Update Hermes on the gateway.',
      /**
       * Browser build only, and a dead end rather than a fault.
       *
       * A session-token gateway is perfectly current and the native apps sign
       * in to it happily. A browser tab cannot: there is no keychain, and
       * anything a page can write a page can read — which is why this build
       * carries no bearer token at all and authenticates with the gateway's own
       * cookie instead. Until this said so, the wizard simply showed a Continue
       * that could never be pressed, with nothing on the screen to do.
       */
      tokenBlockedTitle: 'This gateway cannot be used from a browser',
      tokenBlockedBody:
        'It authenticates with a session token, and a browser tab has nowhere safe to keep one — anything running in the page could read it. Use the Hermie app, or put the gateway behind an identity provider so it can issue a browser session.',
      /**
       * The gateway is gated and every provider it offers is an OIDC/SSO
       * redirect, but this Hermie Web has turned that off (`--no-oidc` /
       * `HERMIE_OIDC=0`) — see `web-config.shared.ts`. Said plainly rather
       * than left as an empty screen or a "no identity providers" line that
       * would blame the gateway for a limit this build chose.
       */
      ssoOff: 'Sign-in with SSO is turned off on this Hermie Web. Ask whoever runs it to sign you in another way.',
      signOutOfSession: 'Sign out',

      webview: {
        title: 'Sign in',
        loading: 'Opening the sign-in page…',
        exchanging: 'Completing sign-in…',
        timeout: 'The sign-in page was open for ten minutes without finishing. Start again when you are ready.',
        cancelled: 'Sign-in was cancelled.',
        unavailable:
          'The in-app browser is not available on this platform. Open the sign-in page in your browser, then paste the address it fails to open back here.',
        // Said when the reader ASKED for the browser. Telling them the in-app
        // page is unavailable would be a plain untruth, and it is the sentence
        // they would read while wondering what went wrong.
        chosen:
          'Open the sign-in page in your browser, then paste the address it fails to open back here. You can go back and use the in-app page instead.',
        headersWithheld:
          'This gateway needs extra headers, and Android\u2019s in-app browser would forward them to your identity provider. Sign in in your browser instead, then paste the address it fails to open back here.',
        fallbackLabel: 'Failed address',
        fallbackPlaceholder: 'http://127.0.0.1:38007/callback?code=…',
        fallbackHelp:
          'The browser will fail to load a 127.0.0.1 address — that is expected. Copy it out of the address bar and paste it here.',
        fallbackSubmit: 'Use this address',
        stateMismatch:
          'The sign-in response did not belong to this attempt and was discarded. Start the sign-in again.',
        noCode: 'The sign-in finished without an authorization code. Start the sign-in again.',
        providerError: (error: string, description: string) =>
          description
            ? `The gateway refused the sign-in: ${description} (${error})`
            : `The gateway refused the sign-in: ${error}`,
        httpError: (status: number) => `The sign-in page answered HTTP ${status}. Check the gateway's public address.`,
        loadError: (message: string) => `The sign-in page could not be loaded: ${message}`
      }
    },

    test: {
      title: 'Test connection',
      subtitle: 'Hermie checks the REST surface and then opens the WebSocket, exactly as it will during use.',
      running: 'Testing\u2026',
      retry: 'Try again',
      required: 'The connection has not been tested yet.',
      invalidated: 'Something changed since the last test, so it is running again.',
      connectedAs: (user: string, bots: number) => `Connected as ${user} · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      connected: (bots: number) => `Connected · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      noBots: 'The connection works, but this gateway has no bot profiles yet.',

      /**
       * The three things the test actually exercises, in the order it does
       * them. They are a checklist rather than one line because when a test
       * fails, WHICH half failed is the whole diagnosis: REST refused is a
       * credential, the socket refused is a reverse proxy.
       */
      checklist: {
        rest: 'REST',
        socket: 'WebSocket',
        profiles: 'Profiles'
      }
    },

    /**
     * The step between a working connection and a finished wizard.
     *
     * It has two faces because the gateway has two states, and they ask for
     * opposite things. With the plugin installed there is a switch to move and
     * the only question is whether to move it now. Without it there is nothing
     * the app can do at all, so the screen's whole job is to hand over two
     * commands and get out of the way — and to be skippable, because the person
     * setting the app up on a train is not the person with a shell open.
     */
    notifications: {
      title: 'Notifications',
      subtitle: 'Your gateway can tell this device when a bot answers, asks for something, or finishes a long task.',
      enable: 'Turn on notifications',
      enabling: 'Asking…',
      enabled: 'Notifications are on for this device.',
      denied: 'Permission was refused. You can turn it on later in your device settings.',
      skip: 'You can turn this on later in Settings.',

      missingTitle: 'Get push notifications',
      missingSubtitle:
        'This gateway has no Hermie plugin, so nothing there can send a notification. It installs with two commands on the machine running `hermes serve`.',
      missingHint:
        'Hermie never talks to the plugin. It reads what your gateway already knows, so there is no second address and nothing new to expose.',
      install: 'ON THE GATEWAY',
      copy: 'Copy',
      copied: 'Copied',
      guide: 'Open guide',
      fallback:
        'Already running Hermie Web with --push? That keeps working, and you can turn notifications on now. Do not run both — they would notify this device twice.'
    },

    done: {
      title: 'Ready',
      subtitle: 'Hermie will store the gateway address on this device and the credentials in the system secret store.',
      // Browser build: there is no credential to store. The session is a cookie
      // the gateway set and the browser keeps, and saying otherwise would
      // promise a keychain that is not there.
      subtitleCookie:
        'Hermie will remember this gateway in this browser. The session itself stays where the gateway put it \u2014 in a cookie Hermie cannot read.',
      gateway: 'Gateway',
      finish: 'Start chatting',
      /** The same button after a failure: it is a retry, and it says so. */
      retry: 'Try again',
      saving: 'Saving…',
      saveFailed: (message: string) => `The settings could not be saved: ${message}`,
      /**
       * The keychain refused, which is neither the address nor the sign-in.
       *
       * Named separately from `saveFailed` because the two send a reader to
       * different places: a save that failed reads as "something about what I
       * typed", and this one is about the device. The platform's own reason is
       * kept on the end — an OSStatus is ugly and it is also the only thing
       * that tells a missing entitlement from a locked device.
       */
      credentialsNotStored: (reason: string) =>
        `Hermie could not store the credentials securely on this device: ${reason}`
    }
  },

  bots: {
    title: 'Chats',
    empty: 'This gateway has no bot profiles yet. Create one with `hermes profile create`.',
    loading: 'Reading the roster…',
    failed: (message: string) => `The bot list could not be loaded: ${message}`,
    noPreview: 'No messages yet',
    running: 'working',
    unread: 'New',
    needsInput: 'Needs your input',
    defaultBot: 'Default',
    search: 'Search chats',
    section: 'MESSAGES',
    conversations: (count: number) => (count === 1 ? '1 conversation' : `${count} conversations`),
    noMatches: (query: string) => `No conversation matches “${query}”.`,

    /**
     * The second half of the search, and the one sentence that has to be right.
     *
     * The gateway answers one hit per conversation (see
     * `packages/gateway-client/src/session-search.ts`), so this heading counts
     * CHATS and never messages. "3 messages" over three rows that are three
     * different chats would be a number nobody could check.
     */
    messagesHeader: 'IN MESSAGES',
    messagesSearching: 'Searching messages…',
    messagesNone: 'No messages match.',
    messagesHint: 'Only the best match per chat is shown.',
    messageOpen: (bot: string) => `Open ${bot}’s chat at this message`,

    unreadLabel: (count: number) => (count === 1 ? '1 unread message' : `${count} unread messages`),
    offline: 'Offline — showing the last saved list.',
    footnote: 'Your conversations stay with your gateway.',
    sidebarHeader: 'CHATS',
    /**
     * The `…` that holds New bot and Boards, at every width.
     *
     * A label rather than a name for what is behind it, because what IS behind
     * it changes with the shell: a compact list has no Boards entry to offer.
     * "More" is the one word that is true in every one of those arrangements.
     */
    moreActions: 'More',

    /**
     * The chat list's title, once it is the gateway's name and a chevron.
     *
     * The label carries the current gateway rather than being a bare "Switch
     * gateway", because a screen reader reaching this control has not been told
     * which gateway the list below it belongs to — and that IS the question the
     * control answers.
     */
    switchGateway: (name: string) => `Gateway: ${name}`,
    switchGatewayHint: 'Choose which gateway this list belongs to',

    /**
     * A share that has arrived and cannot go yet.
     *
     * Said as "waiting to send" rather than "failed", because it is: the entry
     * is on disk and the next reconnect sends it. A row that says something
     * failed invites the reader to do the share again, which would send it
     * twice.
     */
    sharePending: (count: number) => (count === 1 ? '1 share waiting to send' : `${count} shares waiting to send`)
  },

  /**
   * Sharing INTO Hermie from another app.
   *
   * The wording is deliberately about the chat and not about Hermie: by the
   * time any of this is read the reader has already chosen Hermie in the
   * system's own sheet, and repeating the app's name back at them is a line
   * that carries nothing.
   */
  share: {
    sheetTitle: 'Send to a chat',
    noBots: 'This gateway has no bots to send to yet.',
    noteLabel: 'Note',
    notePlaceholder: 'Add a note (optional)',
    send: 'Send',

    /*
      The three lines the iOS share sheet says, and the only strings in this file
      that are read by a process this bundle is not running in.

      They travel to the extension inside `share-targets.json` — see
      `features/share/targets.ts` — because a share extension is a separate
      binary with no access to these translations and the alternative was
      hard-coded English in Swift. So they are written for a sheet that is one
      line tall, with no room for a second sentence, and `sentTo` takes the bot's
      label rather than naming the app: by the time this is read the reader has
      already chosen Hermie in the system's own sheet.
    */
    sending: 'Sending…',
    sentTo: (bot: string) => `Sent to ${bot}`,
    /*
      What is true when the extension could not deliver: no credential, an
      expired one, a gateway that refused, or no network. Deliberately a promise
      about the app rather than an apology — the entry is on disk and the next
      launch sends it, which is exactly what this feature did before it could
      send anything itself.
    */
    willSendLater: 'Will send when Hermie opens',

    /*
      The picker's line for an entry somebody else got as far as submitting.

      It is the one state in this feature that needs a person: the claim says the
      gateway was handed the message and says nothing about whether it took it,
      so sending it again might duplicate and dropping it might lose. Both
      answers are offered and neither is taken automatically. See
      `SHARE_CLAIM_FILE`.
    */
    maybeSent: (bot: string) =>
      bot
        ? `This may already have been sent to ${bot}. Send it again, or discard it.`
        : 'This may already have been sent. Send it again, or discard it.',
    sendAgain: 'Send again'
  },

  /**
   * The four presence states, in words.
   *
   * The bead never carries the state on colour alone — these are what the row
   * and the chat header say out loud, and what a screen reader reads.
   */
  presence: {
    online: 'Online',
    working: 'Working…',
    needsInput: 'Needs input',
    offline: 'Offline',
    offlineSince: (time: string) => `Offline · last seen ${time}`
  },

  /** Arranging the list. All of it is local to this device — see ADR-0012. */
  layout: {
    // Never seeded INTO the field — only ever the placeholder, and only ever
    // the heading a folder nobody has named yet shows. An older build pre-filled
    // the field with "New section", so the first thing typed was appended to it
    // and the owner's device still carries a group literally called
    // "New sectionFinance".
    unnamedFolder: 'Untitled folder',
    rename: 'Rename',
    remove: 'Remove',
    removeFolder: (name: string) => `Delete the ${name || 'untitled'} folder`,
    folderName: 'Folder name',
    nameFolderHint: 'Type to rename this folder.',
    folderEmpty: 'No chats in this folder',
    moveUp: 'Move up',
    moveDown: 'Move down',
    topGroup: 'No folder',
    moveToFolder: (folder: string) => `Move to ${folder}`,
    // The submenu's own heading, so its lines can be bare folder names. The
    // sentence form above is still what the fallback sheet's flat rows say.
    moveToFolderMenu: 'Move to folder',
    openChat: 'Open',
    markRead: 'Mark as read',
    dragging: (name: string) => `Moving ${name}`,
    /**
     * Pin and Unpin, as one line that says what pressing it will do.
     *
     * Deliberately NOT "Pinned" / "Not pinned": every other line in this menu is
     * an instruction, and one that reported a state instead would be the only
     * row a reader has to stop and reason about.
     */
    pin: 'Pin',
    unpin: 'Unpin',
    /** Read out after the row's name, so a pinned chat says so without a glyph. */
    pinnedRow: 'Pinned',
    archive: 'Archive',
    unarchive: 'Unarchive',
    archived: (count: number) => `Archived (${count})`,
    archivedPreview: 'Archived · excluded from filters and counts',
    colour: 'Colour',
    colourOf: (name: string) => `Colour for ${name}`,
    accents: {
      default: 'Default',
      indigo: 'Indigo',
      violet: 'Violet',
      magenta: 'Magenta',
      red: 'Red',
      orange: 'Orange',
      teal: 'Teal',
      green: 'Green',
      graphite: 'Graphite',
      slate: 'Slate',
      lime: 'Lime'
    },
    rowActions: (name: string) => `Actions for ${name}`,
    close: 'Close',

    /**
     * The rail's control, which says what the tap will DO rather than where it is.
     *
     * There is no matching `hideSidebar` here: the rail only ever shows, and the
     * only thing that hides is the chat column's button, whose wording travels
     * with the kit that draws it (`src/chat-ui/strings.ts`). One label per control
     * rather than a pair each has to pick from.
     */
    showSidebar: 'Show sidebar',
    /** The rail's own name, for the reader who lands on it with VoiceOver. */
    sidebarRail: 'Sidebar, hidden',

    /**
     * Folders, which replaced the named dividers ADR-0012 put in the list.
     *
     * A divider was a heading with nothing inside it: there was nothing to
     * close, nothing to count while it was closed and nowhere to drop a row
     * onto. These words are about a container, and the difference shows in
     * every one of them — a folder is deleted rather than removed, it holds
     * chats rather than standing above them, and it can be muted as a group
     * because the group is a thing.
     */
    newFolder: 'New folder',
    deleteFolder: 'Delete folder',
    folderActions: (name: string) => `Actions for the ${name || 'untitled'} folder`,
    folderColour: 'Folder colour',
    /** The disclosure control, which says what the tap will DO. */
    expandFolder: (name: string) => `Show the chats in ${name || 'this folder'}`,
    collapseFolder: (name: string) => `Hide the chats in ${name || 'this folder'}`,
    /** What a closed folder's aggregate badge says to a screen reader. */
    folderUnread: (count: number) => `${count} unread`,
    folderNeedsInput: 'Waiting for you',
    /** Mute is per bot; a folder mutes every chat inside it at once. */
    muteFolder: 'Mute folder',
    unmuteFolder: 'Unmute folder',

    /**
     * Silencing one chat.
     *
     * `mute` is the submenu's heading and `muteFor` the lines inside it, so the
     * lines can be bare spans rather than repeating the verb six words apart —
     * the same split `moveToSection` / `moveToSectionMenu` already makes.
     *
     * `muted` and `mutedUntil` are STATUS rather than actions. They are drawn as
     * a disabled line above Unmute, which is the one place a menu is allowed to
     * say something instead of offering something: a reader who muted a chat on
     * their phone last Tuesday cannot otherwise find out when it comes back.
     */
    mute: 'Mute',
    muteFor: {
      '1h': 'For 1 hour',
      '8h': 'For 8 hours',
      '1w': 'For 1 week',
      forever: 'Until I turn it back on'
    },
    unmute: 'Unmute',
    muted: 'Muted',
    mutedUntil: (when: string) => `Muted until ${when}`,
    /**
     * Short day names, for a deadline that is not today.
     *
     * Indexed by `Date.getDay()`, so Sunday first — the order that index is in,
     * not the order a week reads in.
     */
    muteWeekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    /** What the row's bell glyph says to a reader who cannot see it. */
    mutedRow: 'Muted'
  },

  /**
   * The Mac's menu bar.
   *
   * Here rather than in Swift for the same reason every other string is: one
   * place to read the app's voice. `HermieMenuBar` is handed these and holds no
   * wording of its own, so a translation reaches the menu bar for free.
   */
  menuBar: {
    chats: 'Chats',
    search: 'Search…',
    settings: 'Settings…',
    close: 'Close',
    newConversation: 'New Conversation',
    /**
     * Title Case, unlike everything else in this file, because a Mac menu bar is
     * the one surface where sentence case looks wrong next to the standard items
     * it sits among — View ▸ Enter Full Screen is Apple's, and `Hide sidebar`
     * beside it reads as a typo.
     */
    hideSidebar: 'Hide Sidebar',
    showSidebar: 'Show Sidebar'
  },

  /**
   * The signed-out state, which used to be a small link in a corner and was not
   * noticed. It is now the only thing in the content column.
   */
  signedOut: {
    title: 'Signed out',
    body: (host: string) => `Your session on ${host} has expired, so Hermie cannot reach your bots until you sign in.`,
    bodyNoHost: 'Your session has expired, so Hermie cannot reach your bots until you sign in.',
    signIn: 'Sign in',
    changeGateway: 'Change gateway',
    listNote: 'Showing the last saved list.',
    /**
     * One calm sentence naming what actually ended the session, shown under the
     * body when the auth ring knows.
     *
     * A session that ends without explanation reads as the app's fault, and the
     * only honest way to say otherwise is to say which thing happened. These are
     * kept apart on purpose: "the gateway rejected the saved sign-in" is
     * something only a new sign-in fixes, while "renewing did not complete" is a
     * network story that may well have fixed itself by the time it is read.
     */
    reason: {
      refreshRejected: 'The gateway rejected the saved sign-in, so the session could not be renewed.',
      refreshFailed: 'Renewing the session did not complete, so Hermie could not stay signed in.',
      noRefreshToken: 'There was nothing saved to renew the session with.',
      rejectedAfterRefresh: 'The gateway rejected the sign-in Hermie had just renewed.',
      tokenUnreadable: 'Hermie could not read the saved sign-in from the keychain.'
    },

    /**
     * The same card, for the failures that are not about the credentials.
     *
     * It always names the address, because the report behind it was an install
     * that inherited one: the app said the endpoint was not what it expected
     * and stopped there, without ever saying which endpoint.
     */
    stopped: {
      /**
       * Stepping across to another configured gateway, from the card that says
       * this one cannot be used.
       *
       * Offered on every stop rather than only on the one that named it: a
       * reader looking at a dead machine is a reader for whom "use the other
       * one" is the fastest true answer, whatever killed this one. The rows
       * name the gateway rather than describing the act, because the reader is
       * choosing between machines and not between verbs.
       */
      others: 'OTHER GATEWAYS',
      othersHint: 'Hermie talks to one gateway at a time. This one keeps its conversations.',
      switchTo: (name: string) => `Connect to ${name}`,
      /** Above the title, when the device knows more than one gateway. */
      onGateway: (name: string) => name,

      titles: {
        auth: 'Signed out',
        config: 'This gateway refused the connection',
        takenOver: 'Another client took this connection over',
        chatOff: 'Chat is switched off on this gateway',
        tls: 'This gateway\u2019s certificate was rejected',
        incompatible: 'This gateway is too old',
        protocol: 'This gateway answered in a way Hermie cannot read',
        not_hermes: 'This address is not a Hermes gateway',
        redirect: 'This address leads somewhere else'
      },
      /**
       * Two, and no more.
       *
       * Every other kind already carries its fix in the sentence — a rejected
       * certificate says to trust it, an address that is not a gateway says to
       * check the path prefix — and where the client knows something better
       * than any table could, it attaches its own `hint` and that one wins. A
       * screen that pads every failure with advice teaches the reader to stop
       * reading the advice.
       */
      hints: {
        config: 'If the gateway moved, change the address stored here to the one it publishes as its public URL.',
        takenOver: 'Re-check reclaims the connection once the other client has let go.'
      },
      gateway: 'Gateway',
      notSignedIn: 'Not signed in',
      recheck: 'Re-check',
      rechecking: 'Checking\u2026',
      changeGatewayHint:
        'Opens setup with this address filled in. Your sign-in is kept until a different gateway is applied.',
      signOut: 'Sign out',
      /**
       * The browser build, where there is no address to change.
       *
       * Hermie Web proxies one gateway onto its own origin and the app cannot
       * be steered anywhere else, so offering the wizard would be offering a
       * step that does not exist. See `docs/web.md`.
       */
      fixedByServer:
        'This page is served by Hermie Web, which decides the gateway. Change it where that server is configured.'
    }
  },

  /**
   * What the app says about a cleartext gateway.
   *
   * None of these is a refusal, and only the last one is a warning. A Hermes
   * gateway on a tailnet is normally served over plain http, because WireGuard
   * has already done the encrypting — telling that user off is how a warning
   * stops being read.
   */
  transport: {
    foundOverHttp: 'Found over http://',
    /** Said only when the reader left the scheme out, so the answer was in doubt. */
    foundOverHttps: 'Found over https://',
    httpLoopback: 'Plain http://, and this connection never leaves this machine.',
    httpLocalNetwork: 'Plain http://, to an address on a local network. It is not reachable from outside that network.',
    httpTailnet:
      'Plain http://, over a tailnet address. WireGuard has already encrypted the path between this device and the gateway.',
    httpExposed:
      'Plain http:// to a public address. Anyone on the path can read your messages and your sign-in. Use https://, or reach the gateway over a private network such as Tailscale.',
    useHttps: 'Use https instead'
  },

  gateway: {
    connectionSettings: 'Connection settings',
    latency: (ms: number) => `${ms} ms`,
    noHost: 'No gateway'
  },

  activity: {
    title: 'Activity',
    subtitle: 'Messages between your bots, and the agents they put to work.',
    empty:
      'Your bots have not talked to each other yet. When one messages another or delegates a task, it shows up here.',
    emptyOffline: 'Nothing to show while the gateway is out of reach.',
    loading: 'Reading every conversation…',
    failed: (message: string) => `The timeline could not be loaded: ${message}`,
    today: 'Today',
    yesterday: 'Yesterday',
    counters: {
      working: 'Bots working',
      subagents: 'Sub-agents',
      deliveries: 'Deliveries out'
    },
    /** `researcher → writer`. */
    to: (from: string, to: string) => `${from} → ${to}`,
    /**
     * `writer ↩ researcher`.
     *
     * The variation selector is load-bearing: iOS gives U+21A9 an EMOJI
     * presentation by default, so the arrow renders as a blue glyph in the
     * middle of a sentence unless it is explicitly asked for as text.
     */
    reply: (from: string, to: string) => `${from} \u21a9\ufe0e ${to}`,
    spawned: (bot: string, count: number) => `${bot} spawned ${count} ${count === 1 ? 'agent' : 'agents'}`,
    groupStatus: {
      dispatched: 'dispatched',
      running: 'running',
      done: 'done',
      failed: 'failed'
    } as Record<string, string>,
    openChat: (bot: string) => `Open the chat with ${bot}`
  },

  tabs: {
    chats: 'Chats',
    activity: 'Activity',
    routines: 'Crons',
    settings: 'Settings'
  },

  sidebar: {
    /**
     * Which Hermie Web is serving this page, under the name of whoever is
     * signed in — one block in the chat list's footer rather than two
     * (ADR-0025). The gateway's own host is joined onto it at the call site.
     */
    hermieWeb: (version: string) => `Hermie Web ${version}`
  },

  chat: {
    send: 'Send',
    stop: 'Stop',
    hydrating: 'Loading the conversation…',
    /**
     * The connection, said in the chat rather than in a banner.
     *
     * Not a failure and nothing to dismiss: the chat opens itself once the
     * socket is up. `connecting` names the gateway because on a first open it
     * is the only thing on screen and "Connecting…" on its own could be about
     * anything; the other two are what the header's subtitle already says, and
     * saying it differently two inches apart reads as two different facts.
     */
    connection: {
      connecting: 'Connecting to your gateway…',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
      /** Reset the backoff and dial now. Harmless at any time — see `retryNow`. */
      retry: 'Try now'
    },
    offlineCopy: 'Showing the last saved copy of this conversation.',
    stale: 'This conversation lost its connection to the gateway. It reattaches on the next open.',
    failed: (message: string) => `This conversation could not be opened: ${message}`,
    /**
     * A gateway that refused one SETTING, which is not the conversation failing.
     *
     * These shared a sentence, and the shared one was about opening: a fast
     * mode the model does not offer read as "This conversation could not be
     * opened: fast mode is not available for this model", while the chat was
     * open and working underneath it. The gateway's own wording is kept — it
     * names the setting and the reason — and only what happened to it is added.
     */
    settingRefused: (message: string) => `Setting not changed: ${message}`,
    empty: 'Nothing has been said in this chat yet.',
    /**
     * A search hit opened this chat and the row is not in it.
     *
     * The gateway matched the conversation, not a row — it does not say which
     * one — so this is what honesty sounds like: the chat is the right one, the
     * message is further back than the transcript has, and the reader can scroll.
     */
    findMissed: (query: string) => `“${query}” is in this chat, further back than it has loaded.`,
    /**
     * The same miss, after paging back as far as this is willing to go.
     *
     * A different sentence from `findMissed` because it is a different fact. The
     * transcript now reaches the start of the conversation, or the search walked
     * back further than any reader would have, and in both cases the honest
     * thing is that the words the gateway matched are not in the projection this
     * app searches — a hit on a tool's arguments, for instance, which the FTS
     * index carries and the rendered item does not.
     */
    findExhausted: (query: string) =>
      `“${query}” was matched by the gateway, but it is not in the visible text of this chat.`,
    unknownAuthor: 'Someone else started a turn…',
    thinking: 'Thinking',
    toolRunning: 'running',
    approvalTitle: 'Approval requested',
    clarifyTitle: 'The bot has a question',
    answered: (answer: string) => `Answered: ${answer}`,
    cancelled: 'Withdrawn',
    subagents: (count: number) => (count === 1 ? '1 subagent running' : `${count} subagents running`),
    retry: 'Try again',
    pickBot: 'Pick a conversation to start reading.',
    /**
     * The line under the bot's name.
     *
     * The top half is what the BOT is doing, from `turnActivity`, and the
     * bottom half is what the CONNECTION is doing. `working` is the honest
     * gap between the two: a turn has started and has not yet said which of
     * the others it is.
     *
     * `idle` says Online rather than Connected, because the reader is being
     * told about a bot and not about a socket — and it is the word the chat
     * list's own presence line already uses, which is the point.
     */
    subtitle: {
      working: 'Working…',
      thinking: 'Thinking…',
      typing: 'Typing…',
      /** `Running terminal…` — the tool's own name, as the gateway spells it. */
      running: (tool: string) => `Running ${tool}…`,
      waiting: 'Waiting for you',
      delegating: 'Delegating…',
      queued: 'Queued',
      idle: 'Online',
      offline: 'Offline',
      reconnecting: 'Reconnecting…',
      connecting: 'Connecting…',
      signedOut: 'Signed out'
    },
    attach: {
      photo: 'Photo library',
      file: 'File',
      cancel: 'Cancel',
      title: 'Add an attachment',
      failed: (message: string) => `The attachment could not be added: ${message}`,
      /** Already a whole sentence from `FileUploadError`; this only frames it. */
      uploadFailed: (message: string) => `The file was not sent. ${message}`,
      permission: 'Hermie needs access to your photo library to attach an image. Allow it in Settings.',
      openSettings: 'Open Settings',
      /**
       * Chip-sized reasons. A file chip is about 260pt wide, so the typed
       * error's whole sentence does not fit — it stays in the notice, and the
       * chip says the part that decides what to do next.
       */
      chipTooLarge: (megabytes: number) => `Too large · ${megabytes} MB max`,
      chipNoWorkspace: 'No workspace to upload into',
      chipRefused: 'The gateway refused it',
      chipFailed: 'Upload failed'
    },
    expensiveModel: (message: string) => message || 'This model costs more than the current one.'
  },

  auth: {
    /**
     * A sign-in that produced no refresh token.
     *
     * One sentence, and every word of it is load-bearing: what will happen
     * ("cannot be refreshed"), where the cause is (the gateway's provider, not
     * this app or this device), and what fixes it (the `offline_access` scope).
     * A vaguer version of this reads as "something is wrong" and sends people
     * to re-install the app.
     */
    noRefreshToken:
      'This sign-in cannot be refreshed \u2014 it ends when its access token expires. The gateway\u2019s provider needs the offline_access scope.',
    noRefreshTokenLink: 'How to fix this'
  },

  settings: {
    title: 'Settings',

    /**
     * The category list Settings opens on (HERM-108), and the one line of
     * state under each category's name.
     *
     * A summary says where a setting STANDS, not what the page is for: the
     * reader scanning the list is looking for the thing that is wrong, and
     * "Dark · English" finds it faster than "Colours and language".
     */
    categories: {
      account: 'Account',
      gateways: 'Gateways',
      /**
       * Hermie Web is proxied to one gateway by the server in front of it
       * (`WEB_GATEWAY_BASE_URL`), so there is no list to browse — singular,
       * because a page about one thing is not called by the plural of it.
       */
      gateway: 'Gateway',
      chats: 'Chats & messages',
      notifications: 'Notifications',
      memory: 'Memory',
      appearance: 'Appearance',
      privacy: 'Privacy & security',
      voice: 'Voice',
      capabilities: 'Bots & capabilities',
      advanced: 'Advanced',
      about: 'About',
      /**
       * One sentence per category, on the card its page opens with.
       *
       * Not a summary. A summary says where a setting STANDS — "Dark · English" —
       * and belongs on the row, because a reader scanning the list is looking for
       * the thing that is wrong. These say what the category is FOR, which is the
       * question somebody has once, on arriving. Plain sentences, no marketing,
       * and each one names the thing the page actually decides.
       */
      blurb: {
        account: 'Who this device is signed in as, and the ways of leaving.',
        gateways: 'The gateway this device talks to, and the others it knows about.',
        gateway: 'Which gateway this is, and how it is doing.',
        chats: 'What a new conversation shows, and how a bot is addressed.',
        notifications: 'When a bot may reach you, and how much a notification says.',
        memory: 'What each bot remembers between conversations.',
        appearance: 'Light or dark, the language, the text size and the theme.',
        privacy: 'The lock on this device, and what it takes to open it.',
        voice: 'How Hermie reads a reply out, and how it hears you.',
        capabilities: 'The skills, servers and boards your bots can reach.',
        advanced: 'Hermie Web\u2019s own updates, and the tools for building the app.',
        about: 'Which Hermie this is, and the licences it ships under.'
      },
      summary: {
        signedOut: 'Not signed in',
        gateways: (host: string, count: number) =>
          count === 1 ? `${host} · 1 gateway` : `${host} · ${count} gateways`,
        /** Hermie Web: the host alone. A build that can only ever have one is not counted. */
        gateway: (host: string) => host,
        on: 'On',
        off: 'Off',
        notificationKinds: (count: number) => (count === 1 ? 'On · 1 kind' : `On · ${count} kinds`),
        bots: (count: number) => (count === 1 ? '1 bot' : `${count} bots`),
        capabilities: 'Skills · MCP · Connectors',
        lockBrowser: 'Not in a browser',
        developer: 'Developer',
        version: (version: string) => `Version ${version}`
      }
    },

    /**
     * The sidebar's search field, on the split layout only.
     *
     * It reads a category's title, the line of state under it, and the titles of
     * every page underneath it — so it finds Licences under About and MCP servers
     * under Bots & capabilities. The phone's list has no field: it is one screen
     * of twelve rows, and a box between the reader and a list they can see all of
     * is furniture.
     */
    search: {
      label: 'Search settings',
      noMatches: 'No setting matches that.'
    },

    /**
     * The group header over the four surfaces a bot can be given.
     *
     * Its own group, under the one row that MAKES a bot: "New bot…" is an action
     * and the four under this are places, and a card that mixes the two is a card
     * whose footer cannot say anything true about all five rows.
     */
    capabilityReach: 'What your bots can reach',

    gateway: 'Gateway',
    address: 'Address',
    /**
     * Browser build only, under the gateway's address.
     *
     * The row shows the GATEWAY's host while the address bar shows this app's,
     * and without this line the two read as a contradiction.
     */
    viaHermieWeb: 'via Hermie Web',
    provider: 'Provider',
    version: 'Version',
    user: 'Signed in as',
    /** Settings → Account, when `/api/auth/me` sent one (HERM-120). Empty draws no row at all. */
    email: 'Email',
    authModeToken: 'Session token',

    /** Browser build only: the Hermie Web server this page came from. */
    webUpdate: {
      header: 'Hermie Web',
      running: 'Running',
      state: 'Update',
      checking: 'Checking\u2026',
      upToDate: 'Up to date',
      available: (version: string) => `${version} available`,
      apply: 'Update',
      updating: 'Downloading and installing\u2026',
      restarting: 'Restarting\u2026',
      failed: (reason: string) => `The update failed: ${reason}`,
      needsSignIn: 'Sign in to the gateway before updating Hermie Web.',
      restartTimedOut: 'Hermie Web did not come back within a minute. Check its logs.'
    },
    status: 'Status',
    plugin: 'Plugin',
    pluginInstalled: (version: string) => (version ? `Hermie plugin ${version}` : 'Hermie plugin'),
    pluginAbsent: 'Not installed',
    pluginUnknown: 'Checking…',

    /**
     * ADR-0017. The wording is doing a job: a reader has to be able to tell,
     * from this screen alone, that the notification will say a bot's NAME and
     * nothing else unless they say otherwise.
     */
    notifications: {
      header: 'Notifications',
      enabled: 'Notifications',
      enabledHint:
        'The Hermie plugin runs inside your gateway and sends a notification when a bot has news. Hermie Web with --push does the same job from outside, if a plugin cannot be installed.',
      denied: 'Notifications are turned off for Hermie in your device settings. Turn them on there first.',
      unavailable: 'This device cannot register for notifications. Nothing has been sent.',
      webInsecure: 'The browser only offers notifications when Hermie Web is served over https.',
      types: 'Tell me about',
      typeMessage: 'New message',
      typeRequest: 'Needs input',
      typeCron: 'Routines',
      typeCronDone: 'A routine finished',
      typeCronFailed: 'A routine failed',
      typeTurnDone: 'Finished working',
      typeTurnFailed: 'Something went wrong',
      typesHint:
        'A bot answering, a bot asking permission, a routine’s delivery, how a scheduled run ended, and a long task reaching its end either way. A turn you stopped yourself is never one of these.',
      preview: 'Show a preview',
      previewHint:
        'Off, a notification says which bot and what happened. On, it carries the message as well — and a lock screen is where it will be read.',

      /**
       * What this device's registration actually IS, in one row.
       *
       * The owner's gateway held a push section with a live heartbeat and no
       * registrations at all, and the app said nothing, because every way of
       * failing to obtain a token looked the same from above. Each line below
       * names one of them, and the ones worth trying again get the button.
       */
      status: 'Registration',
      statusOff: 'Off. This device is not registered.',
      statusPending: 'Asking the platform for an address…',
      statusRegistered: (tail: string) => `Registered · …${tail}`,
      statusDenied: 'Permission denied. Turn notifications on for Hermie in your device settings.',
      /*
        The Mac build, where no dialog is ever raised. It names the pane rather
        than describing it, and the button under it opens exactly that pane —
        the owner had to find it by hand before this existed, and until they
        did the switch looked broken.
      */
      statusSystemSettings: 'Turn on notifications for Hermie in System Settings → Notifications',
      openSystemSettings: 'Open Notifications settings',
      openSystemSettingsHint: 'Hermie stays switched on here and registers as soon as macOS allows it.',
      statusNoProject: 'This build has no EAS project id, so it cannot be given a push token. It needs rebuilding.',
      statusFailed: (message: string) => `Token request failed: ${message}`,
      statusUnsupported: (detail: string) => `This device cannot register: ${detail}`,
      retry: 'Retry',
      retryHint: 'Asks for permission again and re-requests a push token.'
    },

    /**
     * The gateways list, which is the primary list once there is more than one
     * of them.
     *
     * The wording keeps two things apart that used to be one, because with a
     * list they are plainly different acts: SWITCHING is stepping across to a
     * machine this device already knows, and REMOVING is forgetting one. The
     * old "Change gateway" survives beside them and means the third thing —
     * editing THIS gateway's address.
     */
    gateways: {
      header: 'Gateways',
      row: 'Gateways',
      rowHint: (count: number) => (count === 1 ? 'One gateway' : `${count} gateways`),
      title: 'Gateways',
      /** Under the list. It says what a tap does, because a tap does a lot. */
      hint: 'Tap a gateway to connect to it. Hermie talks to one at a time; the others keep their conversations and their notifications.',
      active: 'Connected',
      signedInAs: (user: string) => `Signed in as ${user}`,
      signedOut: 'Signed out',
      authModeToken: 'Session token',
      /**
       * The word on the row, said as the act rather than as the state.
       *
       * The footer under the list already said a tap connects, and the owner
       * still read the list as a list. A sentence under a list is a caption; a
       * word on the row is a control.
       */
      use: 'Use this gateway',
      manage: 'Manage',
      add: 'Add gateway',
      addHint: 'Runs setup for another machine. The gateway you are on now stays connected until you switch.',

      /** One gateway, on its own page. */
      detailTitle: 'Gateway',
      name: 'Name',
      nameHint: 'What this gateway is called on this device. It is not sent anywhere.',
      save: 'Save',
      connect: 'Connect to this gateway',
      connectHint: 'Hermie disconnects from the gateway it is on and dials this one.',
      signOut: 'Sign out of this gateway',
      signOutHint: 'Clears its stored credentials and keeps its address.',
      remove: 'Remove this gateway',
      removeHint: 'Forgets its address, its credentials, its conversations and its settings on this device.',
      removeConfirm: 'Remove this gateway and everything stored for it on this device?',
      removeConfirmAction: 'Remove it',
      keepIt: 'Keep it',
      /**
       * Said once, on the page that removes one, because it is the one thing a
       * reader cannot find out afterwards: a gateway with no live socket has
       * nowhere to send the "stop notifying this device" write.
       */
      removeNotifyNote:
        'If this gateway is not the one Hermie is connected to, its notifications stop when it next tries to reach this device rather than straight away.',
      back: 'Gateways'
    },

    account: 'Account',
    signOut: 'Sign out',
    signOutHint: 'Clears the stored credentials and keeps the gateway address.',
    changeGateway: 'Change gateway',
    changeGatewayHint:
      'Reopens setup with this address filled in. Nothing stored is dropped until a different gateway is applied.',
    changeGatewayConfirm: 'Forget this gateway and everything stored for it?',
    confirm: 'Forget it',
    keepIt: 'Keep it',
    developer: 'Developer',
    connectionTest: 'Connection test',
    unknown: 'Unknown',
    chat: 'Chat',
    defaultVerbosity: 'Default verbosity',
    defaultVerbosityHint:
      'How much of a bot’s working-out a new conversation shows. A conversation with its own setting keeps it.',
    showBotToBot: 'Show bot-to-bot',
    showThinking: 'Show thinking',
    appearance: 'Appearance',

    /**
     * The language picker, and the sentence that says what it does NOT do.
     *
     * Hermie is written in English and every other language is a layer over it
     * (`i18n/catalogue.ts`), so the footer is not decoration: a reader who
     * picks Nederlands and then meets an English sentence on a screen nobody
     * has translated yet should have been told to expect that, rather than
     * reading it as a bug in the setting they just used.
     *
     * The three languages name THEMSELVES — English, Nederlands, Deutsch —
     * because a reader looking for their own language is looking for the word
     * they would use for it, not for our word for it. That list lives in
     * `i18n/locales.ts`, not here, for exactly that reason: it must not be
     * translatable.
     */
    language: 'Language',
    languageFollowDevice: 'Follow device',
    languageHint:
      'Hermie is written in English. Dutch and German are translations of it, and anything not yet translated stays in English.',

    theme: 'Theme',
    themeOptions: { system: 'System', light: 'Light', dark: 'Dark' },
    themeHint: 'System follows the device; Light and Dark pin the app either way.',
    botNames: 'Bot names',
    /**
     * Named after the FIELDS, not after an example.
     *
     * An example is a promise about this reader's own bots that the setting
     * cannot keep — on a gateway where nobody has set a display name both
     * orders show the same thing — and these are the two words the bot profile
     * sheet already labels the same two rows with.
     */
    botNameOptions: { profile: 'Profile name', display: 'Display name' },
    botNamesHint:
      'Which name is the large one. The profile name is what the rest of the app addresses a bot by; the display name is the label set on the gateway. A bot with only one of them shows one line. Only used while Hide profile name, below, is off.',
    /**
     * HERM-110: the display name wins outright, order or no order.
     *
     * A separate switch rather than a third option on the order above, because
     * it answers a different question — not which name leads, but whether the
     * OTHER one is shown at all. On, a bot with a display name drops its
     * profile name everywhere that would otherwise print both; a bot with only
     * one name is untouched, because there is nothing to hide.
     */
    hideHandle: 'Hide profile name',
    hideHandleHint:
      'When a bot has a display name, show only that — the profile name it is otherwise shown with drops off the second line. A bot with no display name keeps its one name either way.',
    /**
     * The transcript's own type scale.
     *
     * Named "Chat text size" rather than "Text size" because that is what it is:
     * a factor on the words in a conversation, on top of whatever the system's
     * own Dynamic Type already says. The chat list, the composer and this screen
     * stay the size the device asked for, and the footer says so — a reader who
     * turns it up and then finds their settings unchanged should have been told
     * to expect that.
     */
    chatTextSize: 'Chat text size',
    chatTextSizeHint:
      'Applies to the words in a conversation, on top of the device\u2019s own text size. The rest of the app follows the device.',
    preset: 'THEME',
    presetOptions: { blue: 'Blue', graphite: 'Graphite', lime: 'Lime' },
    /** Said under the cards, because a card shows the theme rather than naming it. */
    presetHint: 'Each theme has a light and a dark face; the setting above picks which one is showing.',

    /**
     * Themes the reader made.
     *
     * Kept behind a disclosure rather than under the cards: creating a theme is a
     * rare thing to want and a long thing to look at, and the six cards above are
     * the answer for everybody who does not want it.
     */
    themes: {
      /** The page the Theme row opens, named for what it holds. */
      title: 'Themes',
      /** The registry title for a pushed theme editor; overridden on the page itself by the theme's own name. */
      editPageTitle: 'Edit theme',
      header: 'YOUR THEMES',
      back: 'Back to settings',
      create: 'New theme',
      createFrom: (preset: string) => `From ${preset}`,
      untitled: 'Untitled theme',
      name: 'Name',
      namePlaceholder: 'Theme name',
      rename: 'Rename',
      delete: 'Delete',
      deleteConfirm: (name: string) => `Delete “${name || 'Untitled theme'}”?`,
      deleteHint: 'The theme is removed everywhere this gateway is signed in.',
      keepIt: 'Keep it',
      empty: 'No themes of your own yet. Start one from a preset and edit its colours.',
      editing: (scheme: string) => `Editing the ${scheme} face`,
      editingHint: 'Switch the setting above to edit the other face.',
      background: 'Background',
      accentFill: 'Accent',
      accentBubble: 'Your bubbles',
      followPreset: 'Follow the preset',
      colourPlaceholder: '#RRGGBB',
      /** The contrast guard, in the reader's words. */
      rejected: (reason: string) => `That colour is not used: ${reason}`,
      reasonMalformed: 'a colour is six hex digits after a #.',
      reasonBubble: (ratio: string) => `white text on it measures ${ratio} : 1, and needs 4.5 : 1.`,
      reasonBackground: (ratio: string) => `the app’s text on it measures ${ratio} : 1, and needs 4.5 : 1.`,
      reasonAccentFill: (ratio: string) =>
        `it measures ${ratio} : 1 against the surface behind it, and a mark needs 3 : 1.`
    },
    about: 'About',
    licences: 'Licences',
    licencesHint: 'The open-source packages Hermie is built from, and what each one asks for.',
    licencesSummary: (count: number) =>
      count === 1
        ? '1 package ships inside Hermie.'
        : `${count} packages ship inside Hermie. Tap one to read its licence.`,
    licencesBack: 'Back to settings',
    licencesLoading: 'Loading the licences…',
    licencesFailed: (message: string) => `The licence list could not be loaded: ${message}`,
    licencesRetry: 'Try again',
    /** A package that names no licence at all. The text it ships is then the whole statement. */
    licencesUndeclared: 'no licence declared',
    licencesNoText: 'This package ships no licence file. The identifier above is everything it declares.',
    licencesScope: (excluded: number) =>
      `Production dependencies only; development tooling and Hermie's own ${excluded} workspace packages are not in the list.`,
    licencesGeneratedBy: (script: string) => `Generated by ${script}, alongside THIRD_PARTY_LICENSES.md.`,

    /**
     * The address, in the parts a reader checks it by.
     *
     * The same rows the stopped-gateway screen prints, so an address read in
     * Settings and an address blamed by a failure read identically. Off the
     * browser only: in a tab the app's own origin is the proxy's, and its
     * scheme and port say nothing about the gateway — see `GatewayAddressRow.web.tsx`.
     */
    host: 'Host',
    scheme: 'Scheme',
    port: 'Port',

    /** The destructive half of what "Change gateway" used to be. */
    forgetGateway: 'Forget this gateway',
    forgetGatewayHint: 'Deletes the address and the credentials from this device and starts setup empty.',

    privacy: 'PRIVACY & SECURITY',

    /**
     * The app lock.
     *
     * The option labels are as short as they can be said, because five
     * segments share one row and a phone is narrow. The hints carry the part
     * that matters and is easy to get wrong: this setting is about THIS
     * device, and nothing about it travels to another one.
     */
    lock: {
      label: 'Require unlock',
      options: {
        off: 'Off',
        immediately: 'Now',
        '1m': '1 min',
        '5m': '5 min',
        '15m': '15 min'
      } as const,
      hint: 'Ask for Face ID, Touch ID or this device’s passcode before Hermie can be read. This setting stays on this device.',
      hintOn:
        'Hermie asks again after it has been away for this long, and always after it has been started fresh. This setting stays on this device.',
      /** Hardware is there, nothing is enrolled: the one refusal that is actionable. */
      noEnrolment:
        'Set up a passcode, Face ID or a fingerprint in your device settings first — otherwise Hermie would lock with no way to open it.',
      unavailable: 'This device has no unlock method Hermie can ask for.',
      passcodeOnly: 'No biometrics are enrolled, so Hermie will ask for this device’s passcode.',
      web: 'Hermie cannot lock itself in a browser: the page and anything enforcing a lock are the same code. Lock the screen or close the tab.',
      /**
       * Every value on this page — Off included — has to be proven with a face,
       * a finger or a passcode before it takes; this is what a refused, failed
       * or cancelled prompt says underneath the still-unchanged row.
       */
      refused: 'Hermie could not confirm it was you, so nothing changed. Choose the option again to try once more.'
    }
  },

  connection: {
    status: {
      disconnected: 'Disconnected',
      probing: 'Checking the gateway…',
      authenticating: 'Authenticating…',
      connecting: 'Connecting…',
      ready: 'Connected',
      reconnecting: 'Reconnecting…',
      paused: 'Paused',
      offline: 'Offline',
      needs_signin: 'Signed out',
      incompatible: 'Not supported'
    },
    reauth: {
      message: 'Your session on this gateway has expired.',
      action: 'Sign in',
      tokenAction: 'Update token',
      saving: 'Signing in…'
    }
  },

  errors: {
    network: (host: string) =>
      `Could not reach ${host}. Check the address, and that the gateway is running and reachable from this device.`,
    /**
     * The same failure, for an address the reader pinned `https://` on
     * themselves. React Native's fetch discards the underlying error, so a
     * certificate this device will not accept and a host that never answered
     * arrive here as the same flat failure — and only one of the two is worth
     * checking the gateway over. Both are named, and so is the way out that
     * costs nothing to try, because the resolver never looked at http:// for a
     * scheme the reader pinned.
     */
    networkOverHttps: (host: string) =>
      `Could not reach ${host} over https://. It is either not answering there, or serving a certificate this device does not trust. Leave the https:// off and Hermie will try http:// as well.`,
    /**
     * Covers both halves of a failed handshake: a certificate this device will
     * not accept, and a port that is not speaking TLS at all. The second is
     * common on a private network, and naming only the certificate sent people
     * looking for one that was never offered.
     */
    tls: (host: string) =>
      `The secure connection to ${host} failed. A self-signed certificate has to be trusted by this device first — or, if the gateway serves plain http there, leave the https:// off and let Hermie find it.`,
    timeout: (host: string) => `${host} did not answer in time. It may be starting up or behind a slow link.`,
    notHermes: (host: string) =>
      `${host} answered, but not like a Hermes gateway. Check the address and any path prefix.`,
    /** What came back, said as what was SEEN and nothing more. */
    landingPage: 'This looks like a web page, not a gateway.',
    /**
     * Where the address points, which is a different fact from what came back.
     *
     * Said only when the host is one `classifyHost` can actually place on a
     * network of its own — an RFC 1918 or CGNAT address, a `.ts.net`,
     * `.internal` or `.local` name, a name with no dots — and only when
     * something either answered with a web page or failed to answer at all on
     * mobile data. An earlier version of this line went out for every landing
     * page on any host, which sent people to check a VPN when what they had was
     * a typo.
     *
     * Deliberately not naming a product. A tailnet is Tailscale, Headscale or
     * anything else somebody runs, and the reader knows which one they have.
     */
    privateNetworkOnly: 'This address only answers on a private network — is this device on the VPN/tailnet?',
    /**
     * Where the answer came from.
     *
     * The iOS URL cache keeps a 301 keyed by bundle id and it survives deleting
     * the app, so a gateway that moved domains once left a redirect behind that
     * a fresh install's first probe was answered out of — silently, months
     * later, reaching a host the owner had left. Nothing is read from it now,
     * and the sentence names the host so the offer under it can be pressed.
     */
    redirected: (from: string, to: string) =>
      `${from} redirected to ${to}, which is a different host. Nothing was read from it.`,
    useRedirectTarget: (host: string) => `Use ${host} instead`,
    /**
     * The way out of a 401 or 403 from something standing in front of the
     * gateway. Generic: Cloudflare Access is one such proxy and the preset
     * behind this button names it, but the sentence must fit the others too.
     */
    openFrontDoor: 'Add the proxy’s credentials',
    authProxy: (status: number) =>
      `An access proxy answered HTTP ${status} before the gateway did. Add its headers under Advanced, or exempt /api/status, /auth/* and /login from it.`,
    server: (status: number) => `The gateway answered HTTP ${status}. It is running but unhealthy; check its logs.`,
    providersUnavailable:
      'The gateway requires a sign-in but reports no identity providers. Configure one on the gateway and try again.',
    signedOut: 'The gateway rejected the credentials. Sign in again.',
    closeAuth: 'The gateway rejected the credentials when the WebSocket opened. Sign in again.',
    closeHost:
      'The gateway does not trust this address. Set its `dashboard.public_url` to the address you entered and restart it.',
    closeTakenOver: 'Another client took this connection over. Close the other client and test again.',
    closeChatOff: 'Chat is switched off on this gateway.',
    closeAbnormal:
      'The WebSocket closed without a reason. A proxy in front of the gateway usually has to be configured to pass WebSocket upgrades through.',
    incompatible: 'This gateway is too old for Hermie. Update Hermes on the gateway.',
    unknown: 'Something went wrong.'
  },

  botProfile: {
    /** The row menu's line, and the label on the header pill that opens the same sheet. */
    menuItem: 'Edit profile',
    open: (name: string) => `Edit ${name}'s profile`,
    title: 'Profile',

    photo: 'PHOTO',
    photoHint: 'Shown on the chat list, the header and every message this bot sends.',
    photoChange: 'Choose a photo',
    photoReplace: 'Change photo',
    photoRemove: 'Remove photo',

    description: 'DESCRIPTION',
    descriptionPlaceholder: 'What this bot is for',
    colour: 'COLOUR',
    colourHint: 'This chat only. It tints the bubbles, the avatar ring and the row in the list.',

    about: 'ABOUT THIS BOT',
    model: 'Model',
    provider: 'Provider',
    session: 'Session',
    gatewayVersion: 'Gateway',
    unknown: '—',

    save: 'Save',
    saving: 'Saving…',
    saveFailed: 'The gateway would not save that.',
    photoFailed: 'That photo could not be uploaded.'
  }
} as const

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `stringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const strings = localised('app', stringsEn)
