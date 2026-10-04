/**
 * The gateway's skill methods in memory, for the Skills page's tests: `skills.manage` (list, search, browse,
 * inspect, install) and the two `profiles` calls the switches ride on, in the shapes `packages/fake-gateway`
 * serves. Skills are held as the DISABLED set per profile, as the gateway stores them.
 */
import { aManageTransport } from './manage-transport'

export const HUB = [
  { name: 'pdf', description: 'Read and fill PDF files.', source: 'bundled', trust: 'official' },
  { name: 'xlsx', description: 'Read and write spreadsheets.', source: 'hub', trust: 'community' },
  { name: 'video', description: 'Cut and caption video.', source: 'hub', trust: 'community' }
]

export function aSkillsGateway(
  options: {
    installed?: Record<string, string[]>
    disabled?: Record<string, string[]>
    /** Make `skills.manage` install answer as an older gateway does. */
    noInstall?: boolean
    /** Answer `profiles.describe` with a failure, as a gateway without it does. */
    noDescribe?: boolean
    hubPages?: number
  } = {}
) {
  const installed: Record<string, string[]> = options.installed ?? { researcher: ['docx', 'pdf'], writer: ['pdf'] }
  const disabled: Record<string, Set<string>> = Object.fromEntries(
    Object.entries(options.disabled ?? { writer: ['pdf'] }).map(([name, list]) => [name, new Set(list)])
  )
  let refuseConfigure: string | null = null
  const writes: string[][] = []

  const transport = aManageTransport(
    {},
    {
      'skills.manage': params => {
        const action = String(params.action ?? 'list')
        const profile = String(params.profile ?? '')
        const query = String(params.query ?? '')

        if (action === 'list') {
          const names = installed[profile] ?? []

          return {
            skills: {
              bundled: names.filter(name => HUB.find(hit => hit.name === name)?.source === 'bundled'),
              installed: names.filter(name => HUB.find(hit => hit.name === name)?.source !== 'bundled')
            }
          }
        }

        if (action === 'search') {
          return {
            results: HUB.filter(hit => hit.name.includes(query.toLowerCase())).map(hit => ({
              name: hit.name,
              description: hit.description
            }))
          }
        }

        if (action === 'browse') {
          const page = Number(params.page ?? 1)
          const pages = options.hubPages ?? 1

          return {
            items: HUB.map(hit => ({
              ...hit,
              identifier: page > 1 ? `${hit.name}-${page}` : hit.name,
              name: page > 1 ? `${hit.name}-${page}` : hit.name
            })),
            page,
            total_pages: pages,
            total: HUB.length * pages
          }
        }

        if (action === 'inspect') {
          const hit = HUB.find(entry => entry.name === query)

          return {
            info: hit
              ? {
                  ...hit,
                  identifier: hit.name,
                  tags: [hit.trust],
                  skill_md_preview: `# ${hit.name}\n\n${hit.description}\n`
                }
              : {}
          }
        }

        if (action === 'install') {
          if (options.noInstall) {
            throw Object.assign(new Error('unknown skills action: install'), { code: 4017 })
          }

          if (!HUB.some(hit => hit.name === query)) {
            throw Object.assign(new Error(`skill '${query}' not found in the hub`), { code: 5024 })
          }

          installed[profile] = [...(installed[profile] ?? []), query]

          return { installed: true, name: query }
        }

        throw Object.assign(new Error(`unknown skills action: ${action}`), { code: 4017 })
      },
      'profiles.describe': params => {
        if (options.noDescribe) {
          throw new Error('unknown method profiles.describe')
        }

        const name = String(params.name)

        return {
          name,
          skills: (installed[name] ?? []).map(skill => ({ name: skill, enabled: !disabled[name]?.has(skill) }))
        }
      },
      'profiles.configure': params => {
        if (refuseConfigure) {
          throw new Error(refuseConfigure)
        }

        const name = String(params.name)
        const list = params.disabled_skills as string[]

        writes.push(list)
        disabled[name] = new Set(list)

        return { ok: true, applied: { skills: true } }
      }
    }
  )

  return {
    ...transport,
    writes,
    disabled,
    refuseConfigure: (message: string) => {
      refuseConfigure = message
    }
  }
}
