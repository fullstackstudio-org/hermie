/**
 * A gateway holding one profile the way the real one does (`methods_profiles.py`): skills are kept as the
 * DISABLED set, toolsets as an optional pin over the gateway's defaults, MCP servers as the ENABLED list, and
 * every `profiles.configure` answers `applied` for the sections it carried. For the bot profile's tests: the
 * model's (`core/bot-profile/model.test.ts`) and the page's (`features/profile/ProfilePage.test.tsx`).
 *
 * `hold(method)` makes the next call of that method wait until `release(method)`, so a test can have two
 * things in flight at once; `fail(method, error)` makes the next call of it throw.
 */
import { vi } from 'vitest'

export interface Call {
  method: string
  params: Record<string, unknown>
}

/** A gateway holding one profile. `hold(method)` makes the next call of it wait until `release()`. */
export function gateway(
  initial: {
    disabledSkills?: string[]
    pinned?: string[] | null
    enabledMcp?: string[]
    soul?: string
    noModels?: boolean
  } = {}
) {
  const calls: Call[] = []
  const profile = {
    description: 'Writes.',
    soul: initial.soul ?? '',
    model: { provider: 'p', model: 'm' },
    disabledSkills: new Set(initial.disabledSkills ?? []),
    pinned: initial.pinned === undefined ? null : initial.pinned,
    mcp: new Set(initial.enabledMcp ?? ['github', 'local'])
  }
  const skills = ['pdf', 'docx', 'xlsx']
  const toolsets = ['files', 'web', 'terminal']
  const defaults = ['files', 'web']
  const holds = new Map<string, Promise<void>>()
  const releases = new Map<string, () => void>()
  const failures = new Map<string, Error>()
  let reloadAsks = true

  const describeNow = () => {
    const on = profile.pinned ?? defaults

    return {
      name: 'writer',
      description: profile.description,
      soul: profile.soul,
      model: { provider: profile.model.provider, default: profile.model.model },
      skills: skills.map(name => ({ name, enabled: !profile.disabledSkills.has(name) })),
      toolsets: toolsets.map(name => ({ name, label: name.toUpperCase(), tool_count: 2, enabled: on.includes(name) })),
      toolsets_pinned: profile.pinned !== null,
      mcp_servers: ['github', 'local'].map(name => ({ name, enabled: profile.mcp.has(name), transport: 'stdio' }))
    }
  }

  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params: structuredClone(params) })

    // A read answers with the profile as it was when the call arrived, however long it then waits.
    const arrived = method === 'profiles.describe' ? describeNow() : undefined
    const hold = holds.get(method)

    if (hold) {
      holds.delete(method)
      await hold
    }

    const failure = failures.get(method)

    if (failure) {
      failures.delete(method)
      throw failure
    }

    switch (method) {
      case 'profiles.describe':
        return arrived
      case 'profiles.configure': {
        const applied: Record<string, boolean> = {}

        if (typeof params.description === 'string') {
          profile.description = params.description
          applied.description = true
        }

        if (typeof params.soul === 'string') {
          profile.soul = params.soul
          applied.soul = true
        }

        let confirm: Record<string, unknown> = {}

        if (typeof params.model === 'string' && typeof params.provider === 'string') {
          if (params.model.includes('expensive') && params.confirm_expensive_model !== true) {
            confirm = { confirm_required: true, confirm_message: `${params.model} costs more.` }
          } else {
            profile.model = { provider: params.provider, model: params.model }
            applied.model = true
          }
        }

        if (Array.isArray(params.disabled_skills)) {
          profile.disabledSkills = new Set(params.disabled_skills as string[])
          applied.skills = true
        }

        if (Array.isArray(params.enabled_toolsets)) {
          profile.pinned = params.enabled_toolsets.length ? (params.enabled_toolsets as string[]) : null
          applied.toolsets = true
        }

        if (Array.isArray(params.enabled_mcp_servers)) {
          profile.mcp = new Set(params.enabled_mcp_servers as string[])
          applied.mcp_servers = true
        }

        return { ok: true, applied, ...confirm }
      }
      case 'model.options':
        if (initial.noModels) {
          throw new Error('unknown method model.options')
        }

        return {
          providers: [
            { slug: 'p', name: 'Provider P', models: ['m', 'm-mini', 'm-expensive'] },
            { slug: 'q', name: 'Provider Q', models: ['m', 'q-1'] }
          ]
        }
      case 'profiles.set_asset':
        return { ok: true, asset: 'avatar' }
      case 'reload.mcp':
        return params.confirm || params.always || !reloadAsks
          ? { status: 'reloaded' }
          : { status: 'confirm_required', message: 'Reply `/reload-mcp now`' }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })

  return {
    request,
    calls,
    profile,
    configures: () => calls.filter(call => call.method === 'profiles.configure').map(call => call.params),
    hold(method: string) {
      holds.set(
        method,
        new Promise<void>(resolve => {
          releases.set(method, resolve)
        })
      )
    },
    release: (method: string) => releases.get(method)?.(),
    fail: (method: string, error: Error) => failures.set(method, error),
    reloadAsks: (ask: boolean) => {
      reloadAsks = ask
    }
  }
}
