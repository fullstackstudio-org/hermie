/**
 * Skills: what a bot has installed, which of it is switched on, and what the hub offers (the Expo app's
 * `features/skills/skills-controller.ts`, which this follows).
 *
 * Two gateway methods with a seam between them that is easy to miss:
 *
 *  - `skills.manage {action: 'list'}` answers a CATEGORY MAP, `{bundled: [...], installed: [...]}`, of names
 *    with no enabled flag. Whether a skill is on is per BOT and lives in `profiles.describe`, as the complement
 *    of the stored disabled set. A page that called only one of them could tell what exists, or what is on, and
 *    never both.
 *  - A switch is written as `disabled_skills`, INVERTED and WHOLE: the gateway replaces the stored set with what
 *    arrives, so sending only the skill that changed would switch every other disabled skill back on. The list
 *    is computed from the rows on screen (`core/bot-profile/params.ts::skillsParams`).
 *
 * Installing from the hub works over the socket (`action: 'install'`); a gateway without it answers
 * `unknown skills action` (4017), and the page then says the command to run on the machine that hosts the
 * gateway. The gateway has no action that uninstalls: the page offers none.
 *
 * Every string in an answer is the hub's or the gateway's text, drawn as characters.
 */
import type { SkillBrowseItem, SkillHubHit, SkillInspectInfo } from '@hermes/shared/gateway-contract'

import type { BotSwitch } from '../bot-profile/details'
import { checkApplied, skillsParams } from '../bot-profile/params'
import { routeErrorOf } from './route-error'
import type { ManageTransport } from './transport'

/** One installed skill, joined across the two methods. */
export interface InstalledSkill {
  name: string
  /** `bundled`, `installed`, or whatever the gateway filed it under. */
  category: string
  /** From `profiles.describe`; `null` when that was not available, and the row then has no switch. */
  enabled: boolean | null
}

/** One row of the hub. */
export interface HubSkill {
  name: string
  description: string
  source: string | null
  trust: string | null
  /** What `install` and `inspect` are asked with: the hub's identifier, else the name. */
  identifier: string
}

export interface HubPage {
  items: HubSkill[]
  page: number
  totalPages: number
}

export interface SkillDetails {
  name: string
  description: string
  source: string | null
  identifier: string | null
  tags: string[]
  preview: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const orNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/**
 * The category map as rows. `skills` is an OBJECT of arrays, and flattening its values is the only honest way
 * to read it: a client that treated it as an array would show an empty page rather than an error.
 */
export const skillRows = (
  skills: Record<string, string[]> | null | undefined,
  enabledByName: ReadonlyMap<string, boolean> | null
): InstalledSkill[] =>
  Object.entries(skills ?? {})
    .flatMap(([category, names]) => (Array.isArray(names) ? names : []).map(name => ({ category, name: text(name) })))
    .filter(row => row.name !== '')
    .map(row => ({ ...row, enabled: enabledByName ? (enabledByName.get(row.name) ?? true) : null }))
    .sort((left, right) => left.name.localeCompare(right.name))

const hubSkill = (hit: SkillHubHit | SkillBrowseItem): HubSkill => {
  const identifier = 'identifier' in hit ? orNull(hit.identifier) : null

  return {
    name: text(hit.name),
    description: text(hit.description),
    source: 'source' in hit ? orNull(hit.source) : null,
    trust: 'trust' in hit ? orNull(hit.trust) : null,
    identifier: identifier ?? text(hit.name)
  }
}

/** `skills.manage {action: 'inspect'}`: `{}` when the identifier resolves nowhere, which is no details. */
export const detailsOf = (info: SkillInspectInfo | null | undefined): SkillDetails | null =>
  info && (info.name || info.description)
    ? {
        name: text(info.name),
        description: text(info.description),
        source: orNull(info.source),
        identifier: orNull(info.identifier),
        tags: Array.isArray(info.tags) ? info.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        preview: text(info.skill_md_preview)
      }
    : null

/** The command to run when the socket cannot install: what the page prints for an older gateway. */
export const skillInstallCommand = (identifier: string, profile: string): string =>
  `hermes --profile ${profile} skills install ${identifier}`

/** Whether a refusal was the gateway saying it has no such action. */
export const isUnknownAction = (failure: unknown): boolean => {
  const error = routeErrorOf(failure)

  return error.code === 4017 || /unknown skills action/iu.test(error.message)
}

export interface SkillsClient {
  /**
   * The installed list with the bot's switch positions. `profiles.describe` may fail on its own (an older
   * gateway may not have it): the list is then drawn without switches, never with switches guessed on.
   */
  installed(profile: string): Promise<InstalledSkill[]>
  /** Write the whole disabled set as the rows say it; rejects when the gateway took the request and did not apply it. */
  writeSwitches(profile: string, rows: readonly Pick<InstalledSkill, 'name' | 'enabled'>[]): Promise<void>
  /** The hub, searched; an empty query browses a page instead. */
  hub(query: string, page: number): Promise<HubPage>
  inspect(identifier: string, profile: string): Promise<SkillDetails | null>
  /** Install one skill from the hub into the bot's skills; resolves with the installed name. */
  install(identifier: string, profile: string): Promise<string>
}

export const HUB_PAGE_SIZE = 20

export function createSkillsClient(gateway: ManageTransport['gateway']): SkillsClient {
  return {
    async installed(profile) {
      const listed = await gateway.request('skills.manage', { action: 'list', profile })
      const described = await gateway
        .request('profiles.describe', { name: profile })
        .then(result => (Array.isArray(result.skills) ? result.skills : []))
        .catch(() => null)

      return skillRows(
        listed.skills,
        described ? new Map(described.map(entry => [text(entry.name), entry.enabled !== false])) : null
      )
    },

    async writeSwitches(profile, rows) {
      const switches: BotSwitch[] = rows.map(row => ({ name: row.name, enabled: row.enabled !== false, transport: '' }))

      checkApplied(await gateway.request('profiles.configure', skillsParams(profile, switches)), 'skills')
    },

    async hub(query, page) {
      const trimmed = query.trim()
      const answer = await gateway.request('skills.manage', {
        action: trimmed ? 'search' : 'browse',
        ...(trimmed ? { query: trimmed } : { page, page_size: HUB_PAGE_SIZE })
      })
      // Two actions, two keys: `search` answers `results` and `browse` answers `items`.
      const hits: (SkillHubHit | SkillBrowseItem)[] = (trimmed ? answer.results : answer.items) ?? []

      return {
        items: hits.map(hubSkill).filter(hit => hit.name !== ''),
        page: trimmed ? 1 : (answer.page ?? page),
        totalPages: trimmed ? 1 : Math.max(1, answer.total_pages ?? 1)
      }
    },

    async inspect(identifier, profile) {
      const answer = await gateway.request('skills.manage', { action: 'inspect', query: identifier, profile })

      return detailsOf(answer.info)
    },

    async install(identifier, profile) {
      const answer = await gateway.request('skills.manage', { action: 'install', query: identifier, profile })

      return answer.name ?? identifier
    }
  }
}
