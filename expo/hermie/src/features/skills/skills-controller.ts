/**
 * Skills: what is installed, what the hub has, and which bot has which on.
 *
 * Two gateway methods with a seam between them that is easy to miss.
 *
 * `skills.manage {action: 'list'}` answers a CATEGORY MAP — `{bundled: [...],
 * installed: [...]}` — of names, and carries no enabled flag at all. Whether a
 * skill is on is per BOT and lives in `profiles.describe`, as the complement of
 * the stored disabled set. So a Skills page that only called `skills.manage`
 * could tell you what exists and never whether any of it is switched on, and
 * one that only called `profiles.describe` would miss everything the hub could
 * install.
 *
 * Installing from the hub really does work over the socket: `_skills_install`
 * calls `do_install(skip_confirm=True)`. That is worth stating because the
 * desktop app's main Skills tab uses REST for it, and the obvious conclusion
 * from reading only that code is that the button cannot exist here.
 */
import type { SkillBrowseItem, SkillHubHit } from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'

/** One installed skill, joined across the two methods. */
export interface InstalledSkill {
  name: string
  /** `bundled`, `installed`, or whatever category the gateway filed it under. */
  category: string
  /** From `profiles.describe`. `null` when no bot was asked about. */
  enabled: boolean | null
}

/** One row of the hub catalogue. */
export interface CatalogueSkill {
  name: string
  description: string
  source: string | null
  /** Already under the chosen bot, so the row offers nothing. */
  installed: boolean
}

/**
 * Flatten the category map into rows.
 *
 * Exported for its own test because the shape is the trap: `skills` is an
 * OBJECT of arrays, and `Object.values(...).flat()` is the only honest way to
 * read it. A client that treated it as an array gets nothing and shows an empty
 * page rather than an error.
 */
export const skillRows = (
  skills: Record<string, string[]> | null | undefined,
  enabledByName: ReadonlyMap<string, boolean> | null
): InstalledSkill[] =>
  Object.entries(skills ?? {})
    .flatMap(([category, names]) => (names ?? []).map(name => ({ category, name })))
    .map(row => ({ ...row, enabled: enabledByName ? (enabledByName.get(row.name) ?? true) : null }))
    .sort((left, right) => left.name.localeCompare(right.name))

export interface SkillsControllerOptions {
  gateway: ChatGateway
}

export class SkillsController {
  constructor(private readonly options: SkillsControllerOptions) {}

  /**
   * The installed list, with each bot's switch position where a bot was named.
   *
   * `profiles.describe` is allowed to fail on its own: an older gateway may not
   * have it, and a list of skills with no switches is still a useful list. What
   * is NOT acceptable is guessing — `enabled: null` means "nobody asked", and
   * the page draws those rows without a switch rather than with one defaulted
   * to on.
   */
  async installed(profile?: string | null): Promise<InstalledSkill[]> {
    const listed = await this.options.gateway.request('skills.manage', {
      action: 'list',
      ...(profile ? { profile } : {})
    })

    if (!profile) {
      return skillRows(listed.skills, null)
    }

    const described = await this.options.gateway
      .request('profiles.describe', { name: profile })
      .then(result => result.skills ?? [])
      .catch(() => null)

    return skillRows(
      listed.skills,
      described ? new Map(described.map(entry => [entry.name, entry.enabled !== false])) : null
    )
  }

  /**
   * Switch one skill for one bot.
   *
   * The wire carries `disabled_skills`, INVERTED and WHOLE: upstream's
   * `save_disabled_skills` replaces the stored set with what arrives, so
   * sending only the skill that changed would switch every other one back on.
   * The full list is computed here from what the page is showing, which is why
   * this takes the rows rather than a single name.
   */
  async setSkillEnabled(
    profile: string,
    rows: readonly InstalledSkill[],
    name: string,
    enabled: boolean
  ): Promise<void> {
    const disabled = rows
      .map(row => (row.name === name ? { ...row, enabled } : row))
      .filter(row => row.enabled === false)
      .map(row => row.name)

    const result = await this.options.gateway.request('profiles.configure', {
      name: profile,
      disabled_skills: disabled
    })

    // `applied` reports each section separately, and a false here means the
    // write was attempted and did not land — which no error frame would say.
    if (result.applied?.skills === false) {
      throw new Error(`The gateway did not apply the skill change for ${profile}.`)
    }
  }

  /** The hub, searched. An empty query browses the first page instead. */
  async search(query: string, page = 1): Promise<CatalogueSkill[]> {
    const trimmed = query.trim()
    const result = await this.options.gateway.request('skills.manage', {
      action: trimmed ? 'search' : 'browse',
      ...(trimmed ? { query: trimmed } : { page, page_size: 20 })
    })

    // Two actions, two keys. `search` answers `results` and `browse` answers
    // `items`, and the fields they carry are not the same either.
    const hits: (SkillHubHit | SkillBrowseItem)[] = trimmed ? (result.results ?? []) : (result.items ?? [])

    return hits.map(hit => ({
      name: String(hit.name ?? ''),
      description: String(hit.description ?? ''),
      source: 'source' in hit && hit.source ? String(hit.source) : null,
      installed: false
    }))
  }

  /**
   * Install one skill from the hub into a bot's skills directory.
   *
   * Upstream answers `{installed: true, name}` and raises on a miss, so a
   * refusal arrives as a thrown error and is shown as one.
   */
  async install(identifier: string, profile?: string | null): Promise<string> {
    const result = await this.options.gateway.request('skills.manage', {
      action: 'install',
      query: identifier,
      ...(profile ? { profile } : {})
    })

    return result.name ?? identifier
  }
}

/**
 * The command to run when the socket cannot do it.
 *
 * Install IS available over the socket, so this is not a fallback for the
 * ordinary case — it is what the page prints when the gateway refuses the
 * action outright, which is what an older gateway without `_skills_install`
 * does (`unknown skills action: install`, code 4017).
 */
export const skillInstallCommand = (identifier: string, profile?: string | null): string =>
  profile ? `hermes --profile ${profile} skills install ${identifier}` : `hermes skills install ${identifier}`

/** Whether a refusal was the gateway saying it has no such action. */
export const isUnknownAction = (error: unknown): boolean =>
  error instanceof Error && /unknown skills action|4017/i.test(error.message)
