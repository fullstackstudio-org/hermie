/**
 * Every literal the chat kit paints.
 *
 * Deliberately its own file rather than `src/i18n/strings.ts`: the kit is a
 * self-contained set of components with its own gallery, and keeping its
 * copy next to it means a component and its wording move together.
 */
import { localised } from '../i18n/catalogue'

const chatStringsEn = {
  /**
   * The typing indicator's accessible name. Three dots say "replying" to
   * everyone who can see them and nothing at all to anyone who cannot.
   */
  replying: 'Replying',
  receipt: {
    sending: 'Sending…',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read'
  },
  /** The `Show more` / `Show less` pair, shared by every fold in the kit. */
  fold: {
    more: 'Show more',
    less: 'Show less'
  },
  assistant: {
    thoughtFor: (seconds: number) => `Thought for ${seconds}s`,
    thinking: 'Thinking',
    replyTo: (handle: string) => `Reply to @${handle}`,
    interim: 'Interim note',
    retry: 'Retry',
    reconnecting: 'Reconnecting…',
    errorTitle: 'Something went wrong',
    footer: (parts: string[]) => parts.join(' · '),
    tokens: (input: string, output: string) => `${input} in · ${output} out`
  },
  tool: {
    running: 'Running…',
    generating: 'Preparing…',
    arguments: 'Arguments',
    result: 'Result',
    rawArguments: 'Arguments (raw)',
    rawResult: 'Result (raw)',
    showMore: 'Show more',
    showLess: 'Show less',
    noResult: 'No result recorded',
    failed: 'Failed',
    riskTitle: 'Untrusted output',
    redacted: 'Redacted before it reached the model',
    expand: 'Expand tool call',
    collapse: 'Collapse tool call'
  },
  botDm: {
    to: (target: string) => `→ ${target}`,
    /**
     * The aside's header, both directions.
     *
     * Short on purpose. The row holds a preview, a clock, a marker and a
     * chevron beside it, and the header is the one part that may not truncate —
     * an aside whose heading has collapsed to `To…` has lost the only thing it
     * was certainly saying.
     */
    asideTo: (handle: string) => `To @${handle}`,
    asideFrom: (handle: string) => `From @${handle}`,
    replied: (name: string) => `${name} replied`,
    sending: 'Sending…',
    queued: 'Queued · waiting for the current task',
    delivered: 'Delivered ✓',
    failed: 'Failed',
    ambiguous: 'Ambiguous target',
    unknown: 'Sent',
    showMore: 'Show more',
    showLess: 'Show less',
    /**
     * The reply marker at the right of a collapsed line. Always present, always
     * static: §5's motion rule puts waiting on a hollow dot, not a blink.
     */
    marker: {
      // U+FE0E after the arrow. Without the text variation selector iOS gives
      // U+21A9 its emoji presentation and a blue glyph lands in the middle of a
      // metadata line — the same trap the Activity timeline hit.
      replied: '↩︎ replied',
      waiting: 'Delivered · waiting for reply',
      failed: 'Failed'
    },
    /**
     * The roll-up more than three consecutive asides collapse into.
     *
     * `with`, not `to`: a run holds both directions, so some of those messages
     * came the other way. The reply count is the dispatches that were answered.
     */
    rollup: (count: number, handle: string, replies: number) =>
      `${count} messages with @${handle} · ${replies} ${replies === 1 ? 'reply' : 'replies'}`,
    /** The same roll-up where the run involved more than one teammate. */
    rollupMixed: (count: number, replies: number) =>
      `${count} messages · ${replies} ${replies === 1 ? 'reply' : 'replies'}`,
    /** The one place a DM line is allowed to navigate away from this chat. */
    openChat: (handle: string) => `Open @${handle}’s chat`,
    reply: 'Reply',
    answered: '↩︎ answered',
    chip: (target: string) => `Message to ${target}`,
    inChip: (name: string) => `Message from ${name}`,
    /** Shown under a pending dispatch while the recipient's turn is running. */
    targetTyping: (handle: string) => `@${handle} is writing…`,
    openTarget: (target: string) => `Opens the chat with ${target}`,
    openSender: (name: string) => `Opens the chat with ${name}`
  },
  subagents: {
    title: 'Agents',
    working: (count: number, elapsed: string) => `${count} ${count === 1 ? 'agent' : 'agents'} working · ${elapsed}`,
    /** The bar's own halves: §5 sets the count in bold and the clock in mono. */
    barCount: (count: number) => `${count} ${count === 1 ? 'agent' : 'agents'} working`,
    barOpen: 'Show',
    idle: 'No agents running',
    goals: (count: number) => `${count} ${count === 1 ? 'goal' : 'goals'}`,
    steer: 'Steer',
    steerPlaceholder: 'Send a correction…',
    stop: 'Stop',
    openTranscript: 'Open transcript',
    transcriptTitle: (goal: string) => `Transcript · ${goal}`,
    transcriptLive: 'Live tail · refreshing every few seconds',
    transcriptStored: 'The child’s own transcript, read-only.',
    transcriptEmpty: 'This agent has not written anything readable yet.',
    transcriptBack: 'Back to the agents',
    steerQueued: 'Steer queued',
    steerRejected: 'Too late to steer — the agent had already finished its last batch.',
    stopped: 'Stopping…',
    status: {
      queued: 'Queued',
      running: 'Running',
      completed: 'Done',
      failed: 'Failed',
      interrupted: 'Stopped'
    },
    groupStatus: {
      dispatched: 'Dispatched',
      running: 'Running',
      done: 'Done',
      failed: 'Failed'
    }
  },
  /**
   * The scheduled-jobs feature is called CRONS everywhere (§6.5) — the nav
   * label, the list, the card. Not "scheduled jobs" in one place and "Crons" in
   * another.
   */
  cron: {
    eyebrow: 'CRON',
    /**
     * The gateway redacts a job name it could not scrub, and the placeholder it
     * substitutes would read as the job's actual name on a card. So the card says
     * nothing about the name rather than something false.
     */
    unnamed: 'Scheduled job',
    ranAt: (time: string) => `ran ${time} · delivered to this chat`,
    delivered: 'delivered to this chat',
    emptyBody: 'The job delivered nothing to show.',
    open: 'Open cron',
    runNow: 'Run now'
  },
  transcript: {
    jumpToLatest: 'Jump to latest',
    newMessages: (count: number) => `${count} new`,
    empty: 'No messages yet',
    /**
     * The row at the far end while a page of older history is in the air.
     *
     * It is a row rather than a spinner over the list because it is at the TOP
     * of an inverted list, where a floating overlay would sit on the oldest
     * message the reader is currently reading. The ellipsis is the point: this
     * appears when the reader has scrolled to the end of what is loaded, and it
     * says the end is not the beginning.
     */
    loadingEarlier: 'Loading earlier…',
    answer: 'Answer',
    answered: 'answered'
  },

  /**
   * A message the reader sent while the bot was still working.
   *
   * "Queued" says where it is, and the three verbs under it are the three
   * things that can still be done about it: put it into the turn that is
   * running, take it back to the field, or drop it.
   */
  queue: {
    label: 'Queued',
    steer: 'Steer',
    edit: 'Edit',
    delete: 'Delete',
    steered: 'Handed to the running turn',
    /**
     * The marker on a steered bubble's own metadata line.
     *
     * A steer is a user turn that did NOT start a turn — it was folded into the
     * one already running — and without a word saying so it is indistinguishable
     * from an ordinary message that the bot then ignored, because the reply it
     * affects was already streaming above it.
     */
    steeredMarker: 'Steered',
    /** The parked messages the strip stack did not have room to draw. */
    more: (count: number) => `+${count} more`,
    steerRejected: 'Too late to steer — the turn was already finishing. It is back in the queue.'
  },

  /**
   * A message's own context menu — what a secondary click on a bubble offers.
   *
   * `copyText` and `copyMarkdown` are both here because a reply IS markdown and the
   * two destinations want different things; see `message-menu.ts`.
   */
  menu: {
    copyText: 'Copy text',
    copyMarkdown: 'Copy as Markdown',
    copyLink: 'Copy link',
    showDetails: 'Show details',
    hideDetails: 'Hide details',
    openBotChat: (handle: string) => `Open @${handle}’s chat`,
    /**
     * Only where a pointer exists and the platform can draw a real text view;
     * see `SelectTextOverlay` and `src/markdown/attributed.ts`.
     */
    selectText: 'Select text',
    /**
     * On your own turn: put it back in the field, cursor and all.
     *
     * "and resend" rather than "Edit": nothing is edited in place. The turn that
     * is already in the conversation stays exactly where it is, and what this
     * does is start a new one from the same words — which is the whole
     * difference between this and what a reader might reasonably expect from a
     * line called "Edit".
     */
    editResend: 'Edit and resend',
    /** On the last reply: ask for it again. */
    regenerate: 'Regenerate',
    /**
     * On a reply: say it out loud.
     *
     * Two lines rather than one toggle, and only ever one of them is drawn. A
     * line that reads `Read aloud` while its reply is being spoken would be a
     * control whose label contradicts what the speaker is doing.
     */
    readAloud: 'Read aloud',
    stopReading: 'Stop reading',
    /** A turn is running, so neither turn-starting line can be taken. */
    turnRunning: 'Wait for the current turn to finish.',
    /** Regenerate was asked for in a conversation with no prompt to repeat. */
    nothingToRegenerate: 'There is no message here to send again.',
    /** What a screen reader announces the menu itself as. */
    message: 'Message actions'
  },

  /** The panel `Select text` opens. */
  selectText: {
    title: 'Select text',
    done: 'Done',
    copyAll: 'Copy all',
    /** The panel itself, for assistive technology. */
    panel: 'Message as selectable text',
    /** Under the title, because ⌘A and ⌘C are the point of the panel. */
    hint: 'Drag to select · ⌘A all · ⌘C copy · Esc to close'
  },
  /** The overlay shown while a file is held over the window. */
  drop: {
    /** One line, on the target itself: what letting go will do. */
    invitation: 'Drop file to attach',
    /** What assistive technology calls the region. */
    region: 'Drop files here to attach them'
  },

  /** The full-screen image viewer, and the cards that open it. */
  viewer: {
    close: 'Close image',
    /**
     * Two verbs, because the action really is two things. A phone or a Mac
     * opens the share sheet; a browser cannot, and downloads instead. Naming
     * the button "Share" in a browser would promise a sheet that is not
     * coming. `SHARE_FILE_VERB` picks which one.
     */
    share: 'Share image',
    download: 'Download image',
    openHint: 'Opens the full-screen view'
  },

  composer: {
    placeholder: 'Message',
    /** The field's accessibility label once the chat knows whose it is. */
    messageTo: (bot: string) => `Message ${bot}`,
    send: 'Send message',
    stop: 'Stop response',
    attach: 'Add attachment',
    /** The catcher behind the attach popover. Only assistive technology reads it. */
    dismissAttach: 'Dismiss attachment menu',
    photoLibrary: 'Photo library',
    chooseFile: 'Choose file',
    /** Shown under the field only where a bare Return sends. */
    keyHint: 'Enter to send · Shift+Enter for a new line',
    removeAttachment: 'Remove attachment',
    queued: (text: string) => `↳ 1 message queued · “${text}”`,
    slashHint: 'Commands',
    /**
     * The popover's own refusal row.
     *
     * It names the METHOD because that is the half a reader can act on — a
     * `commands.catalog` that refuses and a `complete.slash` that refuses are
     * different gateways being wrong in different ways — and the gateway's own
     * words go on the line under it rather than into this sentence, so a long
     * refusal cannot push the heading out of the popover.
     */
    slashUnavailable: (method: string) => `Commands unavailable — ${method}`,
    /** Only after `SLASH_SLOW_MS`; see the note on that constant. */
    slashLoading: 'Loading…',
    /**
     * The tray's own label, and the reason it exists.
     *
     * A staged card and a sent card are the same card — that is the point of
     * §6.7 — so the one thing the tray has to say is which of the two this is.
     * "Not sent yet" rather than "Attached": attached is what it looks like
     * already, and the question a reader actually has is whether it has gone.
     */
    notSentYet: 'Not sent yet',
    pendingCount: (count: number) => (count === 1 ? '1 file' : `${count} files`),
    /** The send button's label while the tray has something in it. */
    sendWithAttachments: (count: number) =>
      count === 1 ? 'Send message with 1 attachment' : `Send message with ${count} attachments`
  },
  header: {
    back: 'Back to chats',
    options: 'Chat options',
    /**
     * The wide layout's sidebar control, which says what the tap will do rather
     * than what the button is.
     *
     * Only Hide: the button exists only while the list is showing, because the rail
     * that replaces the list carries the control to bring it back. `strings.layout`
     * has the rail's Show and `strings.menuBar` the Title Case pair the Mac's menu
     * needs; the kit keeps its own copy because the kit travels on its own.
     */
    hideSidebar: 'Hide sidebar',
    running: 'Running',
    idle: 'Online',
    needsInput: 'Waiting for you',
    offline: 'Offline',
    offlineAt: (time: string) => `Offline · last seen ${time}`,
    /**
     * The pill's own action, which is the bot's profile.
     *
     * Named after what a tap OPENS rather than after the pill, because the pill
     * already reads out the bot's name and its state: a button called "Bot pill"
     * would say the name twice and the useful half not at all.
     */
    profile: (name: string) => `${name} — profile`
  },
  approval: {
    eyebrow: (handle: string) => `PERMISSION REQUEST · @${handle.toUpperCase()}`,
    title: 'Allow this command?',
    /**
     * The lead line above the command well: who is asking, and where it would
     * run. The working directory belongs in this sentence rather than in a
     * labelled block under the command — §6.9 writes it as prose, and a bare
     * path on its own line told a reader nothing about what it was the path of.
     */
    lead: (handle: string, directory?: string) =>
      directory
        ? `@${handle} wants to run one command on your gateway host, in ${directory}.`
        : `@${handle} wants to run one command on your gateway host.`,
    runsOn: 'Runs on your gateway',
    fine: 'Always allow applies to this exact command on this gateway. Change it later in Settings.',
    answeredElsewhere: 'Answered elsewhere',
    timedOut: 'Timed out',
    answered: (choice: string) => `Answered: ${choice}`,
    // The receipt an answered approval leaves in the transcript. It names the
    // decision, not the button: "once" on its own tells a reader nothing a week
    // later, and `Answered: once` was worse — it did not even say allowed.
    outcomes: {
      once: 'Allowed once',
      session: 'Allowed for the session',
      always: 'Always allowed',
      deny: 'Denied'
    } as Record<string, string>,
    // The gateway's own vocabulary (`tools/approval_prompt.py`): once, session,
    // always, deny. An unknown choice keeps its own name rather than being
    // dropped — the buttons are exactly what the server offered.
    choices: {
      once: 'Allow once',
      session: 'Allow for this session',
      always: 'Always allow',
      deny: 'Deny'
    } as Record<string, string>
  },
  clarify: {
    eyebrow: 'A QUESTION FOR YOU',
    title: 'Before I continue',
    step: (current: number, total: number) => `Question ${current} of ${total}`,
    freeText: 'Or answer in your own words',
    freeTextPlaceholder: 'Type an answer…',
    lock: 'Lock answer',
    locked: 'Locked',
    submit: 'Submit',
    // Not "Skip": the button only takes the sheet off the screen. The question
    // stays open on the gateway and stays answerable from the transcript, and
    // a label that promised to skip it would be a lie about what the agent is
    // still waiting for.
    later: 'Later',
    outcome: (answered: number, total: number) =>
      answered >= total ? (total === 1 ? 'Answered' : `Answered all ${total}`) : `Answered ${answered} of ${total}`,
    next: 'Next',
    previous: 'Back',
    multiSelectHint: 'Choose as many as apply'
  },
  /**
   * The context-window reading, wherever it is shown.
   *
   * Its own group rather than a corner of `options`, because two surfaces draw
   * it — the chat's options sheet and the bot profile's read-only block — and a
   * string that lives under one of them would read as belonging to that one.
   */
  context: {
    /** The row's label in a sheet. */
    label: 'Context used',
    /** Under the label: what the number is actually measuring. */
    hint: 'How much of this session\u2019s context window the conversation fills.',
    percent: (percent: number) => `${percent}%`,
    counts: (used: string, limit: string) => `${used} / ${limit}`,
    /** Appended when the gateway flagged its own count as approximate. */
    estimated: '(estimated)'
  },

  /** Taking the conversation out of the app as a file. */
  export: {
    /**
     * Three roles, one string: the options sheet's group heading, the
     * popover's own row label, and the page's title once a reader opens it
     * (HERM-125).
     *
     * Sentence case, like every other heading source string since HERM-106 —
     * `InsetGroup` uppercases its own header at render, so the group still
     * shouts "EXPORT" the same as its neighbours. A row label and a page
     * title do not go through that transform, and a string still typed in
     * capitals showed through as literal "EXPORT" in both.
     */
    header: 'Export',
    /**
     * Two verbs, because the action really is two things: a phone opens the
     * share sheet and a browser can only download. The same rule the image
     * viewer's button already follows.
     */
    shareMarkdown: 'Share as Markdown',
    downloadMarkdown: 'Download as Markdown',
    shareText: 'Share as plain text',
    downloadText: 'Download as plain text',
    /** Under the two rows: what a file will and will not contain. */
    hint: 'The conversation as it is on screen, with whatever this chat\u2019s view settings hide left out.',
    /** How the reader's own turns are labelled in the file. */
    self: 'You',
    /** The file could not be written or the sheet would not open. */
    failed: 'The conversation could not be exported.'
  },

  options: {
    eyebrow: 'This chat',
    colourHint: 'Tints this chat\u2019s avatar ring, its row in the list and the messages you send.',
    title: 'Chat options',
    done: 'Done',
    subtitle: (bot: string) => `For this conversation with ${bot}`,
    yolo: 'YOLO mode',
    yoloHint: 'Skip approval requests',
    fast: 'Fast mode',
    fastHint: 'Prioritize response speed',
    reasoning: 'Reasoning effort',
    model: 'Model',
    modelSearch: 'Search models',
    verbosity: 'Verbosity',
    verbosityOptions: { quiet: 'Quiet', normal: 'Normal', verbose: 'Verbose' },
    showBotToBot: 'Show bot-to-bot',
    showThinking: 'Show thinking',
    /** The root page's three group headings. */
    howHeader: 'How it answers',
    thisChatHeader: 'This conversation',
    viewHeader: 'What this conversation shows',
    /**
     * The button that discards THIS chat's verbosity/bot-to-bot/thinking
     * overrides (`resetChatView`) so it goes back to reading `defaults`.
     *
     * It used to read "Use the default view", which is what a reader picks to
     * SWITCH TO a view named "default" — not what deleting a per-chat override
     * is. The line under it says the same thing again in full, for the reader
     * who taps nothing until they know what a tap does.
     */
    useDefault: "Reset this conversation's view",
    useDefaultHint:
      "Clears this conversation's own verbosity and visibility settings and follows the default from Settings again.",
    usingDefault: 'Following the default set in Settings.',
    usingOverride: 'This conversation has its own view.',
    expensiveTitle: 'This model costs more',
    expensiveConfirm: 'Use it anyway',
    cancel: 'Cancel',

    /**
     * The mute row's value while there is nothing to say.
     *
     * "Off" rather than an empty cell, because a disclosure row with no value
     * reads as a setting nobody has got round to implementing. The muted
     * wordings live in `strings.layout` with the row menu's, so the list and
     * the header cannot drift apart on what "Muted until" looks like.
     */
    notMuted: 'Off',

    /**
     * The transcript's own type scale (`store/text-size.ts`).
     *
     * "Chat text size" rather than "Text size", because the setting really is
     * about the chat and not about the app: a reader who turns it up and finds
     * their chat list unchanged has been told the truth by the label.
     */
    textSize: 'Chat text size',
    textSizes: {
      small: 'Small',
      default: 'Default',
      large: 'Large',
      xlarge: 'Extra large'
    } as Record<string, string>
  },

  /**
   * Per-chat notification types, which are narrower than mute.
   *
   * Mute is "say nothing at all"; these four are "say this but not that", and
   * the wordings name the EVENT rather than the setting — a reader deciding
   * whether to be woken is thinking about what happened, not about a toggle.
   */
  notifications: {
    label: 'Notifications',
    title: 'Notifications',
    subtitle: (bot: string) => `What ${bot} may notify you about`,
    hint: 'These override the global types in Settings for this chat only.',
    following: 'Following the types set in Settings.',
    overridden: 'This chat has its own types.',
    useDefault: 'Use the global types',
    types: {
      turnDone: 'Finished a turn',
      turnFailed: 'A turn failed',
      needsInput: 'Needs your answer',
      cron: 'Scheduled runs',
      cronDone: 'A scheduled run finished',
      cronFailed: 'A scheduled run failed'
    } as Record<string, string>
  },

  /**
   * Sessions: the branches, the retired conversations and the other visible
   * sessions a profile has.
   *
   * "Conversation" throughout rather than "session", which is the gateway's
   * word: a reader has conversations, and the one place the wire's word shows
   * through is the developer screen.
   */
  sessions: {
    branch: 'Branch from here…',
    branchTitle: 'Branch',
    branchFailed: 'This conversation could not be branched.',
    branches: 'Branches',
    /** The page, and the row in the bot profile sheet that opens it. */
    conversations: 'Conversations',
    /** What a branch's chat screen says at the top, so nobody loses the way back. */
    branchOf: (title: string) => `Branch of ${title}`,
    backToMain: 'back to main chat',
    /** Offered once a branch exists, so the reader can go and read it. */
    openNow: 'Open now',
    branchMade: (title: string) => `Branched into ${title}.`,
    /** "Make this the Bot Chat" — the swap, in the words ADR-0007 uses. */
    adopt: 'Make this the Bot Chat',
    adoptFailed: 'The gateway would not make this the Bot Chat.',
    renameFailed: 'This conversation could not be renamed.',
    /** The Conversations page's own empty state, before anything has loaded. */
    loading: 'Reading this bot’s conversations…',
    loadFailed: 'This bot’s conversations could not be read.',
    pin: 'Pin',
    unpin: 'Unpin',
    refresh: 'Refresh',
    refreshFailed: 'This chat could not be refreshed.',
    past: 'Past conversations',
    pastEmpty: 'Nothing but the current conversation.',
    open: 'Open',
    rename: 'Rename',
    renameTitle: 'Rename conversation',
    delete: 'Delete',
    deleteTitle: 'Delete this conversation?',
    deleteBody: (title: string) => `${title} will be removed from the gateway. This cannot be undone.`,
    deleteConfirm: 'Delete',
    deleteFailed: 'This conversation could not be deleted.',
    cancel: 'Cancel',
    /** The one chat that may never be deleted or hidden; see ADR-0007. */
    canonical: 'Current conversation',
    /** ADR-0007, amended: the shared chat and this reader's own, as a switch. */
    whose: 'This conversation',
    shared: 'Shared Bot Chat',
    mine: 'My chat',
    /** The group heading on the Conversations page. */
    mineGroup: 'My chat',
    /** Said under the switch, so nobody has to guess who else is reading. */
    sharedNote: 'Everyone on this gateway shares this conversation.',
    mineNote: 'Only you see this conversation. The bot keeps its own memory.',
    switchFailed: 'This chat could not be switched.',
    /** Shown for `ConversationBusyError`: a switch would drop a running reply or the queue. */
    busy: 'Wait until the reply is finished or clear the queue first.',
    retired: 'Retired',
    messages: (count: number) => (count === 1 ? '1 message' : `${count} messages`)
  },

  /**
   * The list of a bot's conversations — `ConversationListView`, its sheet and
   * (Task 7) its column — and the header button that opens it.
   *
   * Its own group rather than a corner of `sessions`, because `sessions` is the
   * ADR-0007 switch and the archive it built, and every one of those strings
   * stays put until Task 10 removes the switch. This surface replaces the
   * switch; sharing its copy would make the two impossible to retire one at a
   * time. Where the words are genuinely the same sentence — the shared note,
   * rename, delete, cancel, open, the message count, the busy refusal — the row
   * reads `chatStrings.sessions.*` directly rather than repeating it here.
   */
  conversations: {
    /** The always-first row: the shared chat everybody on the gateway is in. */
    groupChat: 'Group chat',
    /** The heading over the reader's own chats. */
    yourChats: 'Your chats',
    /** Before the reader has started one, under `yourChats`. */
    yoursEmpty: 'Start a chat of your own to see it here.',
    /** The row that starts another one. */
    newChat: 'New chat',
    newChatFailed: 'The gateway would not start a new chat.',
    /** An own chat still wearing its birth stamp — the bare lead, unlabelled. */
    firstChat: 'My chat',
    /** The footer link to the archive (branches, past conversations). */
    allConversations: 'All conversations',
    /** The inline rename field's accessible name. */
    renameLabel: 'Chat name',
    /** The sheet's title, and (Task 7) the column's. */
    columnTitle: 'Conversations',
    /** The header button and shortcut that shows the column. */
    showColumn: 'Show conversations',
    /** The header button and shortcut that hides it. */
    hideColumn: 'Hide conversations',
    /** A conversation could not be opened — a switch that failed for a reason other than being busy. */
    openFailed: 'This conversation could not be opened.'
  },

  /**
   * Speaking and listening.
   *
   * Everything here is about the DEVICE doing the work — see
   * `docs/adr/0021-voice-on-device-first.md` — so none of the copy promises a
   * service, names a provider, or implies the conversation leaves the phone.
   */
  voice: {
    /** The options sheet's group. */
    header: 'VOICE',
    /**
     * What a code listing becomes when it is spoken.
     *
     * A shape rather than the characters: see `speech-text.ts` for why forty
     * lines of TypeScript read out loud is worse than a sentence describing it.
     */
    codeBlock: (lines: number) => (lines === 1 ? 'Code block, 1 line' : `Code block, ${lines} lines`),
    autoRead: 'Read replies aloud',
    autoReadHint: 'Each finished reply in this chat, without being asked.',
    rate: 'Speaking rate',
    /** The five stops, named rather than numbered: 0.75× means nothing out loud. */
    rateOptions: {
      slowest: 'Slowest',
      slow: 'Slow',
      normal: 'Normal',
      fast: 'Fast',
      fastest: 'Fastest'
    },
    dictationLanguage: 'Dictation language',
    dictationAuto: 'Device language',
    confirmBeforeSending: 'Confirm before sending',
    confirmBeforeSendingHint: 'Voice mode shows what it heard for a moment first.',
    stopOnBackground: 'Stop when the app closes',
    /** The composer's mic button, in its two states. */
    dictate: 'Dictate',
    dictateStop: 'Stop dictating',
    /** Under the mic while it is listening and nothing has been heard yet. */
    listening: 'Listening…',
    /** The one-line explanation when the reader has refused the microphone. */
    permissionDenied: 'Hermie needs the microphone to take dictation.',
    openSettings: 'Open Settings',
    /** No recognizer on this platform at all — the button is simply not drawn. */
    unavailable: 'Dictation is not available on this device.',
    /** The recognizer heard nothing at all. */
    noSpeech: 'Nothing was heard.',
    /** Anything else the recognizer reported. */
    failed: 'Dictation stopped unexpectedly.',
    /** Voice mode: the overlay and the way in. */
    mode: 'Voice mode',
    modeStart: 'Start voice mode',
    modeLeave: 'Leave voice mode',
    /** The overlay's line under the indicator, one per phase. */
    modeListening: 'Listening',
    modeSending: 'Sending',
    modeThinking: 'Waiting for a reply',
    modeSpeaking: 'Speaking',
    /** Tap anywhere on the overlay while it speaks. */
    modeInterrupt: 'Tap to interrupt',
    /** How to get out, on a surface with no Escape key. */
    modeDismiss: 'Swipe down to leave',
    /** The cancel affordance on the confirmation beat. */
    modeCancel: 'Cancel'
  },
  sheet: {
    close: 'Close'
  }
} as const

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `chatStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const chatStrings = localised('chat', chatStringsEn)
