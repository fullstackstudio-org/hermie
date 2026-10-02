/**
 * Every literal the memory browser paints.
 *
 * Its own file rather than `src/i18n/strings.ts`, for the reason
 * `features/cron/strings.ts` gives: a self-contained feature keeps its copy
 * next to the screen it belongs to.
 *
 * Two of these are worth reading before they are changed. **"Not browsable"**
 * is not an apology for a missing feature — an external provider offers
 * `prefetch(query)` and no call that returns entries, so there is nothing to
 * list and saying so is the accurate answer. And the **missing-plugin** copy
 * names a version because the capability is what is missing rather than the
 * plugin: a gateway can have an older Hermie plugin installed and enabled and
 * still have no memory routes at all.
 */
import { localised } from '../../i18n/catalogue'

const memoryStringsEn = {
  title: 'Memory',
  /** The row on the bot profile sheet, and the entry in Settings. */
  rowTitle: 'Memory',
  rowHint: 'What this bot remembers about its work, and about you.',
  /** The Settings entry, which is a list of bots rather than one bot's memory. */
  botsTitle: 'Memory',
  botsHint: 'Read and edit what each bot remembers.',
  botsEmpty: 'No bots yet.',
  forBot: (name: string) => `${name}'s memory`,

  tabs: {
    entries: 'Entries',
    graph: 'Graph',
    raw: 'Raw'
  },

  sections: {
    memory: 'MEMORY',
    user: 'USER'
  },
  sectionHint: {
    memory: "What the bot has written down about its work. Hermes' own MEMORY.md.",
    user: 'What the bot has written down about you. USER.md.'
  },

  loading: 'Reading memory…',
  /** The gateway answered, and answered with nothing in this file. */
  empty: {
    memory: 'Nothing written down yet.',
    user: 'Nothing written down about you yet.'
  },
  failed: (reason: string) => `Could not read this memory: ${reason}`,
  retry: 'Try again',

  /** The bar. `chars` is the store's own count, delimiter included. */
  usage: (chars: number, limit: number) => `${chars} of ${limit} characters`,
  usageUnbounded: (chars: number) => `${chars} characters`,
  usageLabel: (target: string, percent: number) => `${target} is ${percent}% full`,

  search: {
    placeholder: 'Search this memory',
    clear: 'Clear',
    searching: 'Searching…',
    none: (query: string) => `Nothing matches “${query}”.`,
    count: (found: number) => (found === 1 ? '1 entry' : `${found} entries`),
    /** The plugin matches every word, in any order, as plain text. */
    hint: 'Every word has to appear somewhere in the entry. Order does not matter.'
  },

  add: {
    placeholder: 'Write something down',
    action: 'Add',
    label: (target: string) => `Add to ${target}`
  },

  edit: {
    action: 'Edit',
    save: 'Replace',
    cancel: 'Cancel',
    label: (index: number) => `Edit entry ${index + 1}`
  },

  remove: {
    action: 'Remove',
    label: (index: number) => `Remove entry ${index + 1}`,
    confirmTitle: 'Remove this entry?',
    confirmBody: 'The bot stops being told this. Hermes keeps no history of a memory file.',
    confirm: 'Remove',
    cancel: 'Keep it'
  },

  /** The advert says browsing is offered and editing is not. */
  readOnly:
    'This gateway lets memory be read and not written. Switch on the plugin’s memory.edit for this profile to change that.',

  graph: {
    /** The whole picture's accessible name; the nodes are not separately named. */
    label: 'A map of this memory: the bot, its entries and the topics they share',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    reset: 'Reset',
    empty: 'Nothing to draw yet.',
    loading: 'Drawing…',
    /** The plugin pages over ENTRIES; a page that filled a cap says so. */
    truncated: (shown: number, total: number) =>
      `Showing ${shown} of ${total} entries. The rest are not on this page of the map.`,
    /** Our own cap bit, over and above the plugin's. */
    dropped: (count: number) => `${count} more nodes were left out of the drawing.`,

    /**
     * The same drawing with the window to itself.
     *
     * The card on the page is a square the width of a settings column, which on
     * a phone leaves a 640-unit drawing at about half size before anyone has
     * zoomed — and the pinch that would fix it is competing with the scroll view
     * under it for the same fingers.
     */
    full: {
      open: 'Open full screen',
      title: 'Memory graph',
      close: 'Close',
      /** The wide layout's backdrop, which is a real target with a page behind it. */
      dismiss: 'Close the graph'
    },
    detail: {
      profile: 'This bot',
      topic: 'Topic',
      entry: 'Entry',
      topics: 'MENTIONS',
      noTopics: 'No topics in this entry.',
      /** The button that leaves the map for the list. */
      open: 'Show in the list',
      close: 'Close'
    }
  },

  /**
   * The Raw tab: each backend's stored content, as stored.
   *
   * The browser shows a memory PARSED — entries split on the store's own
   * delimiter — which is what you want to edit and not what you want when the
   * question is "what is actually in there". A heading, a stray blank line, a
   * delimiter that ended up inside an entry: all of them are invisible in a
   * list of entries and all of them are the answer to that question.
   */
  raw: {
    loading: 'Reading what each backend holds…',
    /** The one sentence that makes the tab safe to leave open. */
    readOnly: 'Read-only. Entries are edited on the Entries tab.',
    /** One document that exists and has nothing in it. */
    emptyDocument: 'This one is empty.',
    /** The gateway cut the content; said rather than shown as the whole of it. */
    truncated: 'The gateway sent only the beginning of this one.',
    chars: (chars: number) => `${chars} ${chars === 1 ? 'character' : 'characters'}`,
    /** A backend the gateway does not have at all. */
    unavailable: 'This backend is not available on this gateway.',
    /** The gateway has it, and it cannot be listed. `note` says why, in its words. */
    notListable: 'This backend cannot say what it holds.',
    /** No backend at all came back, which is not the same as one that is empty. */
    none: 'This gateway named no memory backends.',
    /**
     * The plugin is older than the route.
     *
     * A capability answer rather than a failure: the rest of the page works,
     * so the tab says which version grows the route instead of covering the
     * screen in red.
     */
    missing: 'This gateway’s Hermie plugin does not serve raw memory.',
    missingHint: 'Update the plugin on the machine that runs the gateway:',
    missingCommand: 'hermes plugins install hermie'
  },

  providers: {
    header: 'PROVIDERS',
    notBrowsable: 'Not browsable',
    /** Said once, under the list, because it is the same reason for every row. */
    hint: 'An external memory provider answers a bot with text for one turn. It offers no call that lists what it holds, so there is nothing here to show.'
  },

  missing: {
    title: 'The Hermie plugin has no memory browser',
    /**
     * The capability and not the plugin, because those are different states.
     *
     * A gateway may have an older plugin installed, enabled and happily sending
     * notifications, and still answer nothing here.
     */
    body: 'Reading a bot’s memory needs the hermie plugin, version 0.5.0 or newer, installed on the gateway and enabled for this profile.',
    install: 'ON THE GATEWAY',
    guide: 'Read the guide',
    /** A roster has not arrived yet; "not installed" would be a guess. */
    unknown: 'Waiting for the gateway to say what is installed…'
  }
} as const

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `memoryStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const memoryStrings = localised('memory', memoryStringsEn)
