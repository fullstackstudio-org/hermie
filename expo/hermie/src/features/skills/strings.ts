/**
 * Every literal the Skills page paints.
 *
 * A skill is a folder of instructions a bot opens when it needs them, and the
 * page says that once in the footer rather than in every row: the word is the
 * gateway's and the CLI's, so renaming it here would only cost the reader a
 * translation step when they go looking for `hermes skills list`.
 */
import { localised } from '../../i18n/catalogue'

const skillStringsEn = {
  settings: {
    row: 'Skills',
    hint: 'What your bots know how to do'
  },

  title: 'Skills',
  subtitle: 'Instructions your bots can open.',
  back: 'Settings',

  installed: 'INSTALLED',
  installedEmpty: 'No skills installed yet.',
  installedFooter: 'A skill is a folder of instructions a bot opens when it needs them.',
  loading: 'Reading the skills…',
  failed: (reason: string) => `Could not read the skills: ${reason}`,

  /** Which bot's switches are being shown. Without one there are no switches. */
  forBot: (name: string) => `Switches are for ${name}.`,
  noBot: 'Pick a bot to switch skills on and off for it.',
  botPicker: 'Bot',

  catalogue: 'CATALOGUE',
  search: 'Search the hub',
  searchPlaceholder: 'pdf, spreadsheets, video…',
  searching: 'Searching…',
  catalogueEmpty: 'Nothing matched.',
  alreadyInstalled: 'Installed',
  install: 'Install',
  installing: 'Installing…',
  installed_: (name: string) => `Installed ${name}.`,
  installFailed: (reason: string) => `Could not install: ${reason}`,

  /**
   * Shown only when the gateway refuses the action itself — an older gateway
   * without `_skills_install` answers `unknown skills action: install`.
   * Installing over the socket normally works, so this is a genuine fallback
   * rather than the usual path, and it prints the command instead of a shrug.
   */
  cliOnly: 'This gateway cannot install skills over its socket. Run this on the machine that hosts it:',

  toggleFailed: (reason: string) => `Could not change that: ${reason}`
}

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `skillStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const skillStrings = localised('skills', skillStringsEn)
