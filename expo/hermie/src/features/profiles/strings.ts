/**
 * Every literal the bot-making and capability surfaces paint.
 *
 * Its own file for the reason the Crons feature keeps one: copy that lives next
 * to the screen it belongs to moves with it.
 *
 * The word throughout is **bot**, not profile. The gateway calls them profiles
 * and so does its dashboard, but Hermie's entire model is one chat per bot, and
 * a reader who has only ever seen this app has no profile to relate it to. The
 * identifiers still say `profile` wherever they name a gateway parameter.
 */
import { localised } from '../../i18n/catalogue'

const profileStringsEn = {
  settings: {
    /*
      Sentence case, and `InsetGroup` uppercases it at render. Stored as 'BOTS'
      until now, which is the shape HERM-106 took out of every other header in
      the app: a string that carries its own presentation is a string two
      screens can disagree about.
    */
    group: 'Bots',
    newBot: 'New bot…',
    newBotHint: 'Make another bot on this gateway'
  },

  new: {
    title: 'New bot',
    eyebrow: 'A bot of your own',
    handle: 'Handle',
    handlePlaceholder: 'scout',
    handleHint: 'Lower case, no spaces. This is the name the gateway knows it by, and it cannot be changed later.',
    displayName: 'Display name',
    displayNamePlaceholder: 'Scout',
    displayNameHint: 'What Hermie shows in the list. Leave it blank to use the handle.',
    description: 'Description',
    descriptionPlaceholder: 'Looks things up before anyone asks.',
    model: 'Model',
    modelInherit: 'Inherit from the launch bot',
    modelHint: 'A new bot inherits the gateway’s own model unless you pin one here.',
    cloneFrom: 'Clone settings from',
    cloneNone: 'Start fresh',
    cloneHint:
      'A clone copies the source bot’s skills, tools and MCP switches. Its messaging accounts are never copied — two bots cannot hold one Telegram token.',
    create: 'Create bot',
    cancel: 'Cancel',
    creating: 'Making the bot…',
    failed: (reason: string) => `Could not make the bot: ${reason}`,
    /**
     * Shown after a successful create when the gateway pinned no model and
     * inherited none. The bot exists and its chat is open; it just has nowhere
     * to send a message, and saying so here is cheaper than a first reply that
     * is an error.
     */
    withoutModel: 'This bot has no model yet. Pick one in its profile before you write to it.'
  },

  capabilities: {
    row: 'Capabilities',
    rowDetail: 'Skills, tools and MCP servers for this bot',
    title: 'Capabilities',
    loading: 'Reading this bot’s configuration…',
    failed: (reason: string) => `Could not read the configuration: ${reason}`,
    saveFailed: (reason: string) => `The gateway refused the change: ${reason}`,
    toolsets: 'TOOLSETS',
    /**
     * Said plainly because the alternative is a switch list that lies. With no
     * pin the gateway uses its own defaults, and the first switch anybody
     * touches writes a pin of everything currently on.
     */
    toolsetsUnpinned: 'This bot follows the gateway’s defaults. Changing a switch pins the whole list.',
    toolsetsPinned: 'Pinned for this bot.',
    toolCount: (count: number) => `${count} ${count === 1 ? 'tool' : 'tools'}`,
    skills: 'SKILLS',
    skillsEmpty: 'No skills installed for this bot.',
    skillsFooter: 'Skills are folders of instructions the bot can open when it needs them.',
    mcp: 'MCP SERVERS',
    mcpEmpty: 'No MCP servers configured on this gateway.',
    mcpFooter: 'Switching a server on here makes its tools available to this bot.',
    manageMcp: 'Manage servers…',

    /**
     * The `reload.mcp` gate. Upstream answers `confirm_required` with a 200 and
     * a message, and the message is the gateway's own words — so the sheet
     * shows THAT rather than a paraphrase, and only adds what the two buttons
     * do.
     */
    reload: {
      title: 'Apply to running chats?',
      eyebrow: 'MCP reload',
      body: 'MCP servers reload for every live chat. The next message in each one re-sends its full input.',
      now: 'Reload now',
      always: 'Reload, and stop asking',
      alwaysHint: 'Stops the gateway asking again — in the CLI and the desktop app too.',
      later: 'Not now',
      done: 'MCP servers reloaded.',
      failed: (reason: string) => `Could not reload: ${reason}`
    }
  }
}

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `profileStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const profileStrings = localised('profiles', profileStringsEn)
