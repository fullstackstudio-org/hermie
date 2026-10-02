/**
 * Every literal the name rows paint.
 *
 * Its own file rather than `src/i18n/strings.ts`, for the reason
 * `features/cron/strings.ts` gives: copy that lives next to the thing it
 * describes moves with it.
 *
 * The wording splits on ONE fact, and the fact has not changed — only what the
 * app does about it has. A gateway offers a client no way to write a profile's
 * `display_name`: `profiles.configure` has no such field, `profiles.create` has
 * none, and `PATCH /api/profiles/{name}` RENAMES the profile — its directory, its
 * wrapper script, its service and the active-profile pointer — on every profile
 * but `default`.
 *
 * So there are two rows and they are two different things, said out loud rather
 * than folded into one field whose meaning depends on which bot you opened. The
 * **display name** is Hermie's, it is what the list and the header draw, and it
 * cannot break anything. The **profile name** is the gateway's, it is what
 * `@`-mentions, crons, DM lines and the gateway's own logs use, and changing it
 * is an act of its own behind a button that says so.
 */
import { localised } from '../../i18n/catalogue'

const renameStringsEn = {
  /** The editable row, on every profile. Hermie's own name for the bot. */
  displayLabel: 'Display name',
  displayHint: 'What Hermie calls this bot in your list. The gateway keeps the profile’s own name.',
  /** Shown in the field while nobody has given the bot a name of their own. */
  clearHint: 'Leave it empty to fall back to the name the gateway reports.',
  /**
   * The gateway is not going to hear about this name.
   *
   * One quiet line, and only once the roster has actually been read — "we have
   * not looked yet" must never be drawn as "your plugin is too old". It names
   * the plugin rather than the gateway because that is the thing to update, and
   * it does not offer a command: this is a field's footnote, not the install
   * panel the memory page has room for.
   */
  displayAppOnly: 'Stored in Hermie only; the gateway plugin is too old to save it on the gateway.',
  /** 403: the route is there, and this account may not write profiles. */
  displayForbidden: 'This gateway account may not change profile names.',

  /** The other row, which is a fact and not a field. */
  profileLabel: 'Profile name',
  profileHint: 'The name the rest of the app addresses this bot by.',

  /**
   * The separate act, behind its own disclosure.
   *
   * A row rather than a second field always on screen: renaming a profile is
   * rare, it is not undoable from here, and a form that offers it beside a label
   * somebody edits weekly is a form that will have it pressed by accident.
   */
  renameRow: 'Rename profile…',
  renameHint: 'Changes the profile on the gateway itself, not what Hermie shows.',
  renameField: 'New profile name',
  renameAction: 'Rename profile',
  renameBusy: 'Renaming…',
  renameCancel: 'Keep it as it is',
  /**
   * The warning, in the present tense and without a hedge.
   *
   * A separate line rather than part of the hint, because it does not describe
   * the field — it says what pressing the button will do.
   */
  profileWarning: 'Renaming changes the profile name other tools use',
  /** `default` cannot move: its home IS the gateway's installation root. */
  renameDefault: 'The default profile keeps its name. Its home is the gateway’s own directory.',

  placeholder: 'Not set',

  /** Refusals, named by what the gateway answered rather than by a guess at why. */
  refused: 'The gateway would not take that name.',
  missing: (name: string) => `The gateway has no profile called ${name}.`,
  failed: 'That name could not be saved.',
  /** `rename_profile` refuses an empty new name for `default` before the setter sees it. */
  clearRefused: 'The default profile needs a name.',
  /** The local half went wrong after the gateway had already taken the name. */
  partial: (parts: string[]) =>
    `The gateway renamed this bot, but ${parts.join(' and ')} could not be moved across. Reconnect to pick it up.`,
  partialStores: 'the open chats',
  partialCache: 'the cached transcript'
} as const

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `renameStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const renameStrings = localised('botRename', renameStringsEn)
