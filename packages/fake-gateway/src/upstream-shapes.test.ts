/**
 * What every REST route ANSWERS WITH, pinned against the real gateway's handler.
 *
 * The crons list could not load from any gateway at all for two releases, and
 * the reason nobody caught it is written into this file's existence: every test
 * that touched that route drove the fake, the fake agreed with the app, and
 * neither had been compared with `hermes serve`. A fake that lies is worse than
 * no fake — it turns a green suite into evidence for the wrong thing.
 *
 * So each case below names the upstream handler it was read from. Cite the file
 * when you change one, and change the FAKE to match upstream rather than the
 * other way round. Where the two genuinely differ and the app copes, say so in
 * the test rather than leaving the reader to wonder whether anybody looked.
 *
 * Upstream is NousResearch/hermes-agent, `hermes_cli/web_routers/`, at the pin
 * in `packages/hermes-shared/upstream.json`.
 */
import { createHash, randomBytes } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { PLUGIN_ADVERT, startFakeGateway, type FakeGateway } from './server'

const base64url = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let gateway: FakeGateway

const get = async (path: string): Promise<unknown> => fetch(`${gateway.url}${path}`).then(response => response.json())

const keysOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>).sort()

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
})

afterAll(async () => {
  await gateway.close()
})

describe('GET /api/status — status.py::_status_payload', () => {
  it('answers an object with the three keys the probe insists on', async () => {
    const body = (await get('/api/status')) as Record<string, unknown>

    expect(Array.isArray(body)).toBe(false)
    expect(typeof body.auth_required).toBe('boolean')
    expect(Array.isArray(body.auth_flows)).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  /**
   * `status.py` puts the topology rows here, not a list of names. Nothing in the
   * app reads them — which is exactly how the fake got away with `string[]` for
   * three rounds, and exactly why it is worth holding still now.
   */
  it('reports profiles as rows, not as names', async () => {
    const body = (await get('/api/status')) as { profiles: Record<string, unknown>[] }

    expect(body.profiles.length).toBeGreaterThan(0)
    expect(typeof body.profiles[0]?.name).toBe('string')
    expect(body.profiles.every(profile => typeof profile === 'object')).toBe(true)
  })
})

describe('GET /api/auth/me — dashboard_auth/routes.py', () => {
  it('answers exactly the six keys the client maps', async () => {
    expect(keysOf(await get('/api/auth/me'))).toEqual([
      'display_name',
      'email',
      'expires_at',
      'org_id',
      'provider',
      'user_id'
    ])
  })
})

describe('GET /api/profiles — profiles.py::_list_profiles', () => {
  it('wraps the list in `profiles`', async () => {
    const body = (await get('/api/profiles')) as Record<string, unknown>

    expect(Array.isArray(body)).toBe(false)
    expect(Array.isArray(body.profiles)).toBe(true)
  })
})

/**
 * `PATCH /api/plugins/hermie/profiles/{name}` — the plugin's display-name route.
 *
 * Not an upstream shape: this one is the PLUGIN's, and it exists because core's
 * answer is the wrong one. `PATCH /api/profiles/{name}` renames the profile on
 * every profile but `default` — directory, wrapper script, service, the
 * active-profile pointer — so a client that wanted to change what a bot is
 * CALLED had nowhere to send it and kept the name to itself, where no other
 * client on the gateway could see it.
 *
 * What is worth pinning here is the difference from core's route, because a
 * client that assumed the two agreed is the failure this fixture is for: the
 * answer carries no `ok` and no `path`, the limit is 60 and not 64, and the
 * three refusals are three different app behaviours.
 */
describe('/api/plugins/hermie/profiles — the plugin’s display-name route', () => {
  let own: FakeGateway

  afterEach(async () => {
    await own.close()
  })

  const patch = async (name: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${own.url}/api/plugins/hermie/profiles/${name}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

  const advertOf = async (): Promise<{ capabilities?: string[] } | undefined> => {
    const roster = (await fetch(`${own.url}/api/profiles`).then(response => response.json())) as {
      profiles: { ui_meta?: Record<string, { capabilities?: string[] }> }[]
    }

    return roster.profiles.map(row => row.ui_meta?.['hermie-plugin']).find(Boolean)
  }

  const rosterNames = async (): Promise<{ name: string; display_name: string }[]> => {
    const roster = (await fetch(`${own.url}/api/profiles`).then(response => response.json())) as {
      profiles: { name: string; display_name: string }[]
    }

    return roster.profiles
  }

  it('answers the pair it wrote, and nothing core would have sent', async () => {
    own = await startFakeGateway({ port: 0 })

    const response = await patch('researcher', { display_name: 'De Onderzoeker' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'researcher', display_name: 'De Onderzoeker' })
  })

  /** The point of the route: `profiles.list` reads the name back. */
  it('puts the name where the roster reads one from, without moving the id', async () => {
    own = await startFakeGateway({ port: 0 })

    await patch('researcher', { display_name: 'De Onderzoeker' })

    const rows = await rosterNames()

    expect(rows.find(row => row.name === 'researcher')?.display_name).toBe('De Onderzoeker')
    // The identifier does not move. That is the whole difference from core.
    expect(rows.map(row => row.name)).toContain('researcher')
  })

  /** `default` is a label like any other: its home is a directory, not its name. */
  it('names the default profile too', async () => {
    own = await startFakeGateway({ port: 0 })

    expect((await patch('researcher', { display_name: 'Jurist' })).status).toBe(200)
  })

  it('refuses an empty name and one over its own 60', async () => {
    own = await startFakeGateway({ port: 0 })

    expect((await patch('researcher', { display_name: '   ' })).status).toBe(400)
    expect((await patch('researcher', {})).status).toBe(400)
    expect((await patch('researcher', { display_name: 'x'.repeat(60) })).status).toBe(200)
    expect((await patch('researcher', { display_name: 'x'.repeat(61) })).status).toBe(400)
  })

  /** A control character is not something a client could have composed by typing. */
  it('refuses a control character, which no field could carry anyway', async () => {
    own = await startFakeGateway({ port: 0 })

    expect((await patch('researcher', { display_name: 'DeOnderzoeker' })).status).toBe(400)
  })

  it('answers 404 for a profile it does not have', async () => {
    own = await startFakeGateway({ port: 0 })

    expect((await patch('nobody', { display_name: 'Nobody' })).status).toBe(404)
  })

  /** A gateway whose signed-in account may read profiles and not write them. */
  it('answers 403 where the account may not edit profiles', async () => {
    own = await startFakeGateway({ port: 0, profileDisplayName: 'forbidden' })

    expect((await patch('researcher', { display_name: 'De Onderzoeker' })).status).toBe(403)
    expect((await advertOf())?.capabilities).toContain('profiles.display_name')
  })

  /**
   * A plugin older than the route: 404, and the capability is not advertised.
   *
   * Both halves, because a fixture that took the route away while still
   * advertising it would be a gateway nobody has.
   */
  it('answers 404 and advertises nothing when the plugin predates the route', async () => {
    own = await startFakeGateway({ port: 0, profileDisplayName: 'absent' })

    expect((await patch('researcher', { display_name: 'De Onderzoeker' })).status).toBe(404)

    const advert = await advertOf()

    expect(advert?.capabilities).not.toContain('profiles.display_name')
    // The rest of the advert is untouched: only this one string goes.
    expect(advert?.capabilities).toContain('memory.browse')
  })

  it('advertises the capability on a gateway that has the route', async () => {
    own = await startFakeGateway({ port: 0 })

    expect((await advertOf())?.capabilities).toContain('profiles.display_name')
  })
})

/**
 * `POST /api/plugins/hermie/context/turn` — the plugin's turn-claim route.
 *
 * Not an upstream shape either: like the display-name route, this one belongs
 * to the plugin and exists to fill a gap core leaves open. `prompt.submit`
 * carries a `profile` on the socket, but a plugin watching a shared gateway's
 * transcript from the OUTSIDE never sees that field, so it had no way to say
 * which bot was actually sending. The app calls this route right before the
 * `prompt.submit` it is claiming, naming the RUNTIME session id that call is
 * about to carry.
 */
describe('/api/plugins/hermie/context/turn — the plugin’s turn-claim route', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const claim = async (
    body: unknown,
    headers: Record<string, string> = { 'content-type': 'application/json' }
  ): Promise<Response> =>
    fetch(`${live.url}/api/plugins/hermie/context/turn`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

  const advertOf = async (gateway: FakeGateway): Promise<{ capabilities?: string[] } | undefined> => {
    const roster = (await fetch(`${gateway.url}/api/profiles`).then(response => response.json())) as {
      profiles: { ui_meta?: Record<string, { capabilities?: string[] }> }[]
    }

    return roster.profiles.map(row => row.ui_meta?.['hermie-plugin']).find(Boolean)
  }

  /** A real runtime session id, the same shape `session.resume` hands the app. */
  const liveRuntimeId = async (profile: string): Promise<string> => {
    const listed = await call('session.list', { profile, title: 'Bot Chat', include_hidden: true })
    const chat = ((listed.result as { sessions: Record<string, unknown>[] }).sessions[0] ?? {}) as Record<
      string,
      unknown
    >
    const resumed = await call('session.resume', { session_id: String(chat.id), omit_messages: true })

    return String((resumed.result as { session_id: string }).session_id)
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  it('claims a live runtime session with a bare 204', async () => {
    const runtime = await liveRuntimeId('researcher')
    const response = await claim({ session_id: runtime })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('answers 404 for a session id nobody holds', async () => {
    const response = await claim({ session_id: 'not-a-live-runtime-id' })

    expect(response.status).toBe(404)
  })

  it('answers 415 when the body is not sent as JSON', async () => {
    const response = await claim({ session_id: 'whatever' }, { 'content-type': 'text/plain' })

    expect(response.status).toBe(415)
  })

  it('advertises the capability on a gateway that has the route', async () => {
    expect((await advertOf(live))?.capabilities).toContain('context.turn_claim')
  })

  it('answers 404 and advertises nothing when the plugin predates turn claims', async () => {
    const absent = await startFakeGateway({ port: 0, turnClaim: false })

    try {
      const response = await fetch(`${absent.url}/api/plugins/hermie/context/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'whatever' })
      })

      expect(response.status).toBe(404)

      const advert = await advertOf(absent)

      expect(advert?.capabilities).not.toContain('context.turn_claim')
      // The rest of the advert is untouched: only this one string goes.
      expect(advert?.capabilities).toContain('memory.browse')
    } finally {
      await absent.close()
    }
  })
})

describe('/api/plugins/hermie/memory — the plugin’s dashboard/plugin_api.py', () => {
  /*
    Pinned against the PLUGIN's own tests (`tests/test_memory.py`,
    `tests/test_memory_routes.py`) rather than against what a browser would find
    convenient. Everything asserted here is a decision that file made and
    documented, and the three that reach into the app are:

      - an id is POSITIONAL (`memory:3`), because a memory file is `"\n§\n"`-
        joined text with no ids, so a write is addressed by TEXT;
      - both targets are always named, even when one is empty;
      - an external provider carries `enumerable: false`, because
        `MemoryProvider` has `prefetch(query)` and no call that returns entries.

    Own gateway per test: `edit` mutates the files.
  */
  let own: FakeGateway

  beforeEach(async () => {
    own = await startFakeGateway({ port: 0 })
  })

  afterEach(async () => {
    await own.close()
  })

  const route = '/api/plugins/hermie/memory'

  const read = async (path: string): Promise<Record<string, unknown>> =>
    fetch(`${own.url}${route}${path}`).then(response => response.json() as Promise<Record<string, unknown>>)

  const edit = async (body: Record<string, unknown>) =>
    fetch(`${own.url}${route}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

  it('names both targets on list, even when one of them is empty', async () => {
    const body = await read('/list?profile=writer')
    const targets = body.targets as Record<string, unknown>[]

    expect(targets.map(row => row.target)).toEqual(['memory', 'user'])
    expect((targets[1] as { entries: unknown[] }).entries).toEqual([])
  })

  it('mints a POSITIONAL id and reports what each entry costs', async () => {
    const body = await read('/list?profile=researcher')
    const memory = (body.targets as Record<string, unknown>[])[0] as { entries: Record<string, unknown>[] }

    expect(memory.entries.map(row => row.id)).toEqual(['memory:0', 'memory:1', 'memory:2'])
    expect(keysOf(memory.entries[0])).toEqual(['chars', 'id', 'index', 'target', 'text', 'topics'])
  })

  /**
   * The count is the store's: entries joined by the delimiter, not summed. A
   * listing that disagreed with the store about how full a file is would have
   * somebody deleting entries to fix a number that was never true.
   */
  it('counts usage the way the store spends it, delimiter included', async () => {
    const body = await read('/list?profile=researcher')
    const memory = (body.targets as Record<string, unknown>[])[0] as {
      entries: { text: string }[]
      chars: number
      limit: number
    }
    const summed = memory.entries.reduce((total, row) => total + row.text.length, 0)

    expect(memory.chars).toBe(summed + '\n§\n'.length * (memory.entries.length - 1))
    expect(memory.limit).toBe(2200)
  })

  it('names an external provider and says it cannot be enumerated', async () => {
    const providers = (await read('/list?profile=researcher')).providers as Record<string, unknown>[]

    expect(providers.find(row => row.name === 'builtin')?.enumerable).toBe(true)
    expect(providers.filter(row => row.name !== 'builtin').every(row => row.enumerable === false)).toBe(true)
  })

  /** `memory/browse.py::matches` — every word, any order, plain text. */
  it('searches across both targets, matching every word in any order', async () => {
    const hit = await read('/search?profile=researcher&q=tailnet%20address')
    const miss = await read('/search?profile=researcher&q=tailnet%20invoices')

    expect(hit.count).toBe(1)
    expect((hit.results as { target: string }[])[0]?.target).toBe('memory')
    expect(miss.count).toBe(0)
  })

  /** A query that looks like a regular expression is read as text. */
  it('does not treat a query as a pattern', async () => {
    expect((await read('/search?profile=researcher&q=.*')).count).toBe(0)
  })

  it('refuses a search with no query', async () => {
    expect((await fetch(`${own.url}${route}/search?profile=researcher`)).status).toBe(400)
  })

  /** `memory/__init__.py::_clean_profile` rejects rather than sanitises. */
  it('refuses a profile that is really a path, and one that is missing', async () => {
    for (const profile of ['../../etc', 'a/b', '..', '', 'a%5Cb']) {
      expect((await fetch(`${own.url}${route}/list?profile=${profile}`)).status).toBe(400)
    }
  })

  it('answers the store’s own result dict on a write, rather than a translation', async () => {
    const added = (await (
      await edit({ profile: 'writer', target: 'user', op: 'add', content: 'Likes semicolons.' })
    ).json()) as Record<string, unknown>

    expect(added).toEqual({ success: true, target: 'user' })

    const replaced = (await (
      await edit({
        profile: 'writer',
        target: 'user',
        op: 'replace',
        old_text: 'Likes semicolons.',
        content: 'Likes em dashes.'
      })
    ).json()) as Record<string, unknown>

    expect(replaced).toEqual({ success: true, replaced_entry: 'Likes semicolons.' })

    const removed = (await (
      await edit({ profile: 'writer', target: 'user', op: 'remove', index: 0 })
    ).json()) as Record<string, unknown>

    expect(removed).toEqual({ success: true })
    expect(((await read('/list?profile=writer')).targets as { entries: unknown[] }[])[1]?.entries).toEqual([])
  })

  /**
   * A stale index names nothing rather than its neighbour, and the refusal
   * carries the target as the store re-read it.
   */
  it('refuses an entry that is no longer there and hands back what is', async () => {
    const body = (await (await edit({ profile: 'writer', target: 'memory', op: 'remove', index: 9 })).json()) as Record<
      string,
      unknown
    >

    expect(body.success).toBe(false)
    expect(Array.isArray(body.current_entries)).toBe(true)
  })

  it('accepts only the two real targets and the three real operations', async () => {
    expect((await edit({ profile: 'writer', target: 'notes', op: 'add', content: 'x' })).status).toBe(400)
    expect((await edit({ profile: 'writer', target: 'memory', op: 'drop', content: 'x' })).status).toBe(400)
  })

  it('has no routes at all on a gateway with no plugin', async () => {
    const bare = await startFakeGateway({ port: 0, plugin: false })

    try {
      expect((await fetch(`${bare.url}${route}/list?profile=researcher`)).status).toBe(404)
    } finally {
      await bare.close()
    }
  })

  /**
   * Browsing and editing switch off per profile, through that profile's own
   * config, and the route says so with a 403 rather than an empty answer.
   */
  it('answers 403 when the half being asked for is switched off', async () => {
    const readOnly = await startFakeGateway({
      port: 0,
      plugin: { ...PLUGIN_ADVERT, capabilities: ['memory.browse'] }
    })

    try {
      expect((await fetch(`${readOnly.url}${route}/list?profile=researcher`)).status).toBe(200)
      expect(
        (
          await fetch(`${readOnly.url}${route}/edit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ profile: 'researcher', target: 'memory', op: 'add', content: 'x' })
          })
        ).status
      ).toBe(403)
    } finally {
      await readOnly.close()
    }
  })
})

describe('PATCH /api/profiles/{name} — profiles.py::_rename_profile', () => {
  /*
    Its own gateway, and a fresh one per test: these cases MUTATE the profile
    list, and the module-wide gateway above is read by every other `describe`
    here, which would then be asserting against a roster somebody renamed.

    Read out of Hermes 0.21.3. The route is `PATCH`, not `POST …/rename`, and
    `new_name` is the only body key (`ProfileRename` in
    `hermes_cli/web_models.py`). There is no WebSocket method that does this —
    `groups.rename` renames a room, `pet.rename` a mascot, `session.title` a
    session — which is why the app's only profile write that leaves the socket
    is this one.
  */
  let own: FakeGateway

  beforeEach(async () => {
    own = await startFakeGateway({ port: 0 })
  })

  afterEach(async () => {
    await own.close()
  })

  const rename = async (name: string, newName: string) =>
    fetch(`${own.url}/api/profiles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ new_name: newName })
    })

  /**
   * The `default` profile's home IS the installation root, so it cannot be
   * renamed. Hermes turns the call into a presentation-only display name and
   * says so by answering WITH `display_name` and an unchanged `name`.
   */
  it('answers the default profile with a display_name and its id unchanged', async () => {
    const body = (await (await rename('researcher', 'Jurist')).json()) as Record<string, unknown>

    expect(body.ok).toBe(true)
    expect(body.name).toBe('researcher')
    expect(body.display_name).toBe('Jurist')
    expect(typeof body.path).toBe('string')
  })

  /**
   * Any other profile is REALLY renamed — directory, wrapper script, service,
   * active-profile pointer — and the answer carries no `display_name` at all.
   * The app reads that absence as "the handle moved", so it is the difference
   * between rekeying every store and rekeying none.
   */
  it('answers any other profile with the new id and NO display_name', async () => {
    const body = (await (await rename('writer', 'scribe')).json()) as Record<string, unknown>

    expect(body).not.toHaveProperty('display_name')
    expect(body.name).toBe('scribe')
    expect(body.path).toContain('scribe')

    const listed = (await fetch(`${own.url}/api/profiles`).then(response => response.json())) as {
      profiles: Record<string, unknown>[]
    }

    expect(listed.profiles.map(row => row.name)).toContain('scribe')
    expect(listed.profiles.map(row => row.name)).not.toContain('writer')
  })

  /** `FileNotFoundError` -> 404. Not a 400, and not a silent creation. */
  it('refuses a profile that does not exist with 404', async () => {
    expect((await rename('nobody', 'somebody')).status).toBe(404)
  })

  /**
   * `rename_profile` refuses an empty new name for `default` before the setter
   * sees it, so clearing THAT one is not reachable over this route — even
   * though `set_profile_display_name` itself treats an empty string as "remove
   * the key".
   */
  it('refuses an empty name on the default profile with 400', async () => {
    expect((await rename('researcher', '   ')).status).toBe(400)
  })

  /** `ValueError` / `FileExistsError` -> 400: over 64 characters, or a name in use. */
  it('refuses a name over 64 characters, and one that is already taken, with 400', async () => {
    expect((await rename('writer', 'x'.repeat(65))).status).toBe(400)
    expect((await rename('writer', 'researcher')).status).toBe(400)
  })
})

describe('GET /api/cron/jobs — cron.py::_list_cron_jobs_sync', () => {
  /**
   * The one that cost a release. `_list_cron_jobs_sync` builds a plain list and
   * returns it; FastAPI serialises that as a top-level JSON array. There is no
   * `{"jobs": …}` envelope anywhere in the Python gateway, which is why a
   * transport that demanded an object made the list unreachable everywhere.
   */
  it('answers a BARE ARRAY, with no envelope around it', async () => {
    const body = await get('/api/cron/jobs?profile=all')

    expect(Array.isArray(body)).toBe(true)
    expect((body as unknown[]).length).toBeGreaterThan(0)
  })

  it('annotates every row with the store it came from — `_annotate_cron_job`', async () => {
    const rows = (await get('/api/cron/jobs?profile=all')) as Record<string, unknown>[]

    for (const row of rows) {
      expect(typeof row.profile).toBe('string')
      expect(typeof row.profile_name).toBe('string')
      expect(typeof row.is_default_profile).toBe('boolean')
    }
  })

  /**
   * `_job_state` produces `scheduled`, `paused`, `completed` or `error`. The
   * fake used to say `active`, a word no gateway has ever sent.
   */
  it('uses the state vocabulary the store actually writes', async () => {
    const rows = (await get('/api/cron/jobs?profile=all')) as Record<string, unknown>[]

    for (const row of rows) {
      expect(['scheduled', 'paused', 'completed', 'error']).toContain(row.state)
    }
  })
})

describe('GET /api/cron/jobs/{id} — cron.py::_get_cron_job_sync', () => {
  it('answers the bare job, with no `{job: …}` wrapper', async () => {
    const body = (await get('/api/cron/jobs/job-heartbeat')) as Record<string, unknown>

    expect(body.id).toBe('job-heartbeat')
    expect(body.job).toBeUndefined()
    expect(typeof body.prompt).toBe('string')
  })

  /**
   * `get_job` matches on the ID alone; only `/trigger` goes through
   * `resolve_job_ref`, which is the single place a name may stand in for one.
   * The fake used to accept a name everywhere, so a client could be written
   * against a route that 404s on a real gateway.
   */
  it('404s for a NAME where upstream would, and takes one on trigger', async () => {
    const byName = await fetch(`${gateway.url}/api/cron/jobs/${encodeURIComponent('VM heartbeat')}`)

    expect(byName.status).toBe(404)

    const triggered = await fetch(`${gateway.url}/api/cron/jobs/${encodeURIComponent('VM heartbeat')}/trigger`, {
      method: 'POST'
    })

    expect(triggered.status).toBe(200)
  })
})

describe('GET /api/cron/jobs/{id}/runs — cron.py::_list_cron_job_runs_sync', () => {
  it('wraps the rows in `runs` and echoes the requested, clamped limit', async () => {
    const body = (await get('/api/cron/jobs/job-heartbeat/runs?limit=20')) as Record<string, unknown>

    expect(Array.isArray(body.runs)).toBe(true)
    expect(body.limit).toBe(20)
  })

  /**
   * A run row is `dict(sqlite_row)` over the sessions table, and that table has
   * NO status column: the outcome is `end_reason`. The fake invented `status`,
   * which meant this app's run history read "ok" against this server whatever
   * the run did — and would have read "ok" against a real gateway for every run
   * ever, because the key it was looking for is never sent.
   */
  it('carries `end_reason`, never a `status` the sessions table does not have', async () => {
    const body = (await get('/api/cron/jobs/job-heartbeat/runs')) as { runs: Record<string, unknown>[] }

    expect(body.runs.length).toBeGreaterThan(0)

    for (const run of body.runs) {
      expect(run.status).toBeUndefined()
      expect(typeof run.end_reason).toBe('string')
      expect(run.source).toBe('cron')
      expect(typeof run.profile).toBe('string')
    }

    // …and not every run says the same word, or nothing here would notice which
    // key was being read.
    expect(new Set(body.runs.map(run => run.end_reason)).size).toBeGreaterThan(1)
  })
})

describe('GET /api/cron/delivery-targets — cron.py + scheduler_delivery.py', () => {
  it('wraps the rows and names them the way the delivery module does', async () => {
    const body = (await get('/api/cron/delivery-targets')) as { targets: Record<string, unknown>[] }

    expect(body.targets[0]).toEqual({
      id: 'local',
      name: 'Local (save only)',
      home_target_set: true,
      home_env_var: null
    })
    expect(body.targets[1]?.name).toBe('Bot Chat (researcher)')
  })
})

describe('DELETE /api/cron/jobs/{id} — cron.py::_delete_cron_job_sync', () => {
  it('answers `{ok: true}` and nothing else', async () => {
    const body = await fetch(`${gateway.url}/api/cron/jobs/job-cleanup`, { method: 'DELETE' }).then(r => r.json())

    expect(body).toEqual({ ok: true })
  })
})

describe('GET /api/sessions/{id}/messages — sessions.py::_get_session_messages', () => {
  const chat = async (): Promise<string> => {
    const jobs = (await get('/api/cron/jobs?profile=researcher')) as Record<string, unknown>[]

    expect(jobs.length).toBeGreaterThan(0)

    // Any stored session will do; the cron run sessions are the ones with a
    // predictable id.
    const runs = (await get(`/api/cron/jobs/job-heartbeat/runs`)) as { runs: Record<string, unknown>[] }

    return String(runs.runs[0]?.id)
  }

  it('names the session it read and pages with `pagination`', async () => {
    const body = (await get(`/api/sessions/${encodeURIComponent(await chat())}/messages?limit=50`)) as Record<
      string,
      unknown
    >

    expect(keysOf(body)).toEqual(['messages', 'pagination', 'profile', 'session_id'])
    expect(keysOf(body.pagination)).toEqual(['limit', 'offset', 'order', 'returned'])
    // `count` is what the fake used to send. Upstream has never sent it, and
    // nothing on either side ever read it.
    expect(body.count).toBeUndefined()
  })

  /**
   * The row shape a real gateway ALWAYS takes and the fake never used to.
   * `sessions.py` reads `dict(messages_row)`, so the body is `content` and the
   * key is `id`; `text` and `row_id` belong to the socket's `session.history`.
   */
  it('answers rows keyed as the messages table keys them', async () => {
    const body = (await get(`/api/sessions/${encodeURIComponent(await chat())}/messages`)) as {
      messages: Record<string, unknown>[]
    }

    expect(body.messages.length).toBeGreaterThan(0)

    for (const row of body.messages) {
      expect(typeof row.role).toBe('string')
      expect(typeof row.content).toBe('string')
      expect(row.text).toBeUndefined()
      expect(row.row_id).toBeUndefined()
    }
  })

  /**
   * `offset` skips from the end `order` names, and the page comes back oldest
   * first either way.
   *
   * Measured against a real gateway (0.21.3) on 2026-09-21, because this route
   * is not vendored here and the fake used to parse this parameter, echo it in
   * `pagination` and then ignore it — a fake advertising paging it did not do,
   * which is the one kind of infidelity a test written against the fake cannot
   * catch. The app's older-history paging rests on exactly this.
   */
  it('pages from the end `order` names, and answers oldest first', async () => {
    const session = await chat()
    const all = (await get(`/api/sessions/${encodeURIComponent(session)}/messages?limit=500&order=oldest`)) as {
      messages: { content: string }[]
    }

    expect(all.messages.length).toBeGreaterThan(2)

    const page = async (query: string) =>
      (
        (await get(`/api/sessions/${encodeURIComponent(session)}/messages?${query}`)) as {
          messages: { content: string }[]
        }
      ).messages.map(row => row.content)

    const contents = all.messages.map(row => row.content)

    expect(await page('limit=1&order=latest')).toEqual(contents.slice(-1))
    expect(await page('limit=1&order=latest&offset=1')).toEqual(contents.slice(-2, -1))
    expect(await page('limit=2&order=latest&offset=1')).toEqual(contents.slice(-3, -1))
    expect(await page('limit=1&order=oldest&offset=1')).toEqual(contents.slice(1, 2))
    // Past the end is an empty list, not an error.
    expect(await page('limit=5&order=latest&offset=9999')).toEqual([])
  })
})

describe('GET /api/sessions/search — sessions.py::search_sessions', () => {
  it('wraps the hits in `results`, and answers one for a blank query at all', async () => {
    expect(keysOf(await get('/api/sessions/search?q=introduce'))).toEqual(['results'])
    expect(await get('/api/sessions/search?q=')).toEqual({ results: [] })
  })

  /**
   * The projection, and what it costs.
   *
   * The handler asks `SessionDB.search_messages` for exactly
   * `("session_id", "role", "snippet", "source", "model", "session_started")`
   * and then merges `get_session_rich_row` onto it. `search_messages` CAN
   * return the message's `id` and `timestamp` — the field list allows both —
   * and this route does not ask for either. So a hit names a conversation and
   * never a message, and "open the chat at that row" is work the client has to
   * do for itself. Running the real `search_messages` on a scratch database is
   * what settled that; nothing in the response shape says it out loud.
   */
  it('names a conversation, never a message', async () => {
    const body = (await get('/api/sessions/search?q=introduce')) as { results: Record<string, unknown>[] }

    expect(body.results.length).toBeGreaterThan(0)

    for (const hit of body.results) {
      expect(typeof hit.session_id).toBe('string')
      expect(hit.timestamp).toBeUndefined()
      expect(hit.row_id).toBeUndefined()
      expect(hit.message_id).toBeUndefined()
    }
  })

  /**
   * One `state.db` per profile, so one search per profile.
   *
   * `_open_session_db_for_profile` resolves the profile to its own home and
   * opens the `state.db` there. There is no call that searches the whole
   * gateway, and an unknown profile is a 404 out of `_cron_profile_home`
   * rather than an empty result — which is what a fan-out over a roster has to
   * be written to survive.
   */
  it('is scoped to one profile, and 404s a profile that is not there', async () => {
    const all = (await get('/api/sessions/search?q=introduce')) as { results: unknown[] }
    const one = (await get('/api/sessions/search?q=introduce&profile=writer')) as { results: unknown[] }

    expect(all.results.length).toBeGreaterThan(one.results.length)
    expect((await fetch(`${gateway.url}/api/sessions/search?q=introduce&profile=nobody`)).status).toBe(404)
  })
})

/**
 * The one RPC in this file, and it earns its socket.
 *
 * `session.active_list` is where the fake lied in the most expensive way
 * available: it FILTERED ON `profile`, upstream does not, and so every test that
 * drove it agreed with an app that was calling it once per bot and marking the
 * bot busy if any row came back. One bot working painted the working bead on
 * every row in the chat list, and nothing here could see it.
 *
 * Upstream is `tui_gateway/methods_session.py`, `session.active_list`: a plain
 * `@method` over the process's live sessions. It takes `ProfileParams` and reads
 * only `current_session_id` from them. The rows come from
 * `server.py::_session_live_item`, whose contract is
 * `contracts/sessions.py::SessionActiveItem`.
 */
describe('session.active_list over the socket — methods_session.py::session.active_list', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const activeRows = async (params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> =>
    ((await call('session.active_list', params)).sessions ?? []) as Record<string, unknown>[]

  beforeAll(async () => {
    // Slow the stream right down: every assertion below needs the session to
    // still be running when it reads the list.
    live = await startFakeGateway({ port: 0, streamDelayMs: 400 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter) {
          pending.delete(id as number)
          waiter((frame.result ?? {}) as Record<string, unknown>)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  /** The researcher's stored session id, and a turn running on it. */
  const busyResearcher = async (): Promise<string> => {
    const profiles = (await call('profiles.list', { include_sessions: true })).profiles as Record<string, unknown>[]
    const researcher = profiles.find(row => row.name === 'researcher')
    const stored = String((researcher?.canonical_session as Record<string, unknown> | undefined)?.id ?? '')

    expect(stored).not.toBe('')

    await call('session.resume', { session_id: stored })
    await call('prompt.submit', { session_id: stored, text: 'Take your time.' })

    return stored
  }

  it('answers with the ten fields `SessionActiveItem` declares, and no others', async () => {
    await busyResearcher()

    const rows = await activeRows()

    expect(rows.length).toBeGreaterThan(0)
    expect(keysOf(rows[0])).toEqual([
      'current',
      'id',
      'last_active',
      'message_count',
      'model',
      'preview',
      'session_key',
      'started_at',
      'status',
      'title'
    ])
  })

  /**
   * The field the app has to attribute a row with. `_session_live_item` sets
   * `id` to the runtime session id and `session_key` to
   * `_session_lookup_key` — the agent's own session id, else the stored key.
   * They are different strings, and neither of them encodes the profile.
   */
  it('reports the runtime id and the stored key as two different ids, with no profile on either', async () => {
    const stored = await busyResearcher()
    const row = (await activeRows()).find(entry => entry.session_key === stored)

    expect(row, 'the busy session is missing from the list').toBeDefined()
    expect(row?.id).not.toBe(row?.session_key)
    expect(row).not.toHaveProperty('profile')
    expect(row).not.toHaveProperty('profile_home')
  })

  /**
   * The bug, held still. Asking for `writer` returns the `researcher` row,
   * because upstream never looks at the parameter — so a client cannot read
   * "these are that profile's sessions" out of the answer, however it asked.
   */
  it('IGNORES the `profile` parameter, exactly as upstream does', async () => {
    const stored = await busyResearcher()

    const asWriter = await activeRows({ profile: 'writer' })
    const unscoped = await activeRows()
    const nonsense = await activeRows({ profile: 'no-such-profile' })

    expect(asWriter.map(row => row.session_key)).toContain(stored)
    expect(asWriter.map(row => row.session_key).sort()).toEqual(unscoped.map(row => row.session_key).sort())
    expect(nonsense.map(row => row.session_key)).toContain(stored)
  })

  /** Every row the list reports is one the gateway calls busy. */
  it('lists only live sessions, so an idle profile contributes no row', async () => {
    const stored = await busyResearcher()
    const rows = await activeRows()

    expect(rows.every(row => typeof row.status === 'string' && row.status !== 'idle')).toBe(true)
    expect(rows.map(row => row.session_key)).toContain(stored)
  })
})

/**
 * The native token endpoints, pinned against `hermes_cli/dashboard_auth/routes.py`.
 *
 * These matter more than most routes here: the client turns a status code from
 * the refresh endpoint straight into "keep this session" or "delete the refresh
 * token", and it cannot undo the second one. Which codes mean which is therefore
 * a contract, not an implementation detail.
 */
describe('POST /auth/native/refresh — routes.py::auth_native_refresh', () => {
  const refresh = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${gateway.url}/auth/native/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  /**
   * routes.py:501-502, `if not body.refresh_token: raise _http(400, ...)`. The
   * only 400 this route answers, and the reason the client may treat 400 as
   * final: it can never describe a transient condition.
   */
  it('answers 400 `refresh_token required` for an empty token', async () => {
    const empty = await refresh({ refresh_token: '', provider: 'self-hosted' })

    expect(empty.status).toBe(400)
    expect(empty.body.detail).toBe('refresh_token required')
  })

  /**
   * routes.py:516-519. Expired, unknown, and rejected-by-every-provider all
   * collapse into this one answer, with an `error` key no other route in
   * `dashboard_auth` sends and — unlike the gate's 401 in `middleware.py:73-76` —
   * no `login_url`.
   */
  it('answers 401 `session_expired` for a token it does not know', async () => {
    const unknown = await refresh({ refresh_token: 'rt-never-issued', provider: 'self-hosted' })

    expect(unknown.status).toBe(401)
    expect(unknown.body.error).toBe('session_expired')
    expect(typeof unknown.body.detail).toBe('string')
    expect(unknown.body.login_url).toBeUndefined()
  })

  /**
   * The codes this route cannot answer with, which is what lets the client treat
   * them as retryable. Upstream has no rate limiter on any native route — the
   * only 429 in `dashboard_auth` is `/auth/password-login` (routes.py:382-384) —
   * and no 403 literal exists in the package at all. If upstream ever did start
   * refusing a grant with one of these, this is where it would be noticed, and
   * `DEFINITIVE_REFRESH_STATUSES` in `native-auth.ts` is what would have to move.
   */
  it('never refuses a grant with 403, 408 or 429', async () => {
    const refused = await refresh({ refresh_token: 'rt-never-issued', provider: 'self-hosted' })

    expect([403, 408, 429]).not.toContain(refused.status)
  })

  /**
   * `_bearer_payload`, routes.py:110-115 — the shape BOTH `/auth/native/token`
   * and `/auth/native/refresh` answer with.
   *
   * `expires_at` is unix SECONDS: pinned at the dataclass (`base.py:18`, "unix
   * seconds; the access_token's exp claim"), computed as the raw JWT `exp`
   * (`_shared.py:177`) or `int(time.time()) + ttl` (`basic/__init__.py:172-173`),
   * and there is no `* 1000` anywhere in the package. There is no `expires_in`
   * key to fall back on either. A client reading it as milliseconds would put the
   * expiry some fifty thousand years out and never refresh proactively at all,
   * which is a bug that hides until the access token lapses.
   */
  it('rotates into the six-key bearer payload, with expires_at in unix seconds', async () => {
    const gated = await startFakeGateway({ port: 0, auth: 'native' })

    try {
      const verifier = base64url(randomBytes(32))
      const authorize = new URL(`${gated.url}/auth/native/authorize`)
      authorize.searchParams.set('provider', 'self-hosted')
      authorize.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:8765/callback')
      authorize.searchParams.set('state', 'state-1')
      authorize.searchParams.set('auto', '1')

      const redirected = await fetch(authorize, { redirect: 'manual' })
      const code = new URL(String(redirected.headers.get('location'))).searchParams.get('code')

      const exchanged = await fetch(`${gated.url}/auth/native/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier })
      })
      const issued = (await exchanged.json()) as Record<string, unknown>

      expect(exchanged.status).toBe(200)
      expect(keysOf(issued)).toEqual([
        'access_token',
        'expires_at',
        'provider',
        'refresh_token',
        'token_type',
        'user_id'
      ])
      expect(issued.token_type).toBe('Bearer')
      expect(issued.expires_in).toBeUndefined()

      // Seconds, not milliseconds: the same instant in ms would be ~1.7e12.
      const expiresAt = issued.expires_at as number
      expect(expiresAt).toBeGreaterThan(Date.now() / 1000)
      expect(expiresAt).toBeLessThan(Date.now())

      const rotated = await fetch(`${gated.url}/auth/native/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: issued.refresh_token, provider: 'self-hosted' })
      })
      const next = (await rotated.json()) as Record<string, unknown>

      expect(rotated.status).toBe(200)
      expect(keysOf(next)).toEqual(keysOf(issued))
      // Rotation: a new refresh token, and the old one is spent.
      expect(next.refresh_token).not.toBe(issued.refresh_token)

      const replayed = await fetch(`${gated.url}/auth/native/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: issued.refresh_token, provider: 'self-hosted' })
      })

      /**
       * Upstream keeps no refresh-token store of its own; rotation happens at the
       * identity provider, and `refresh_singleflight.py` caches a successful
       * rotation for 30 s (`_SUCCESS_TTL`), so a replay inside that window gets
       * **200 with the same body** and only afterwards reaches the provider and
       * becomes a 401. The fake refuses immediately instead, which is the case
       * the client has to survive — and on a provider with reuse detection the
       * replay does not merely fail, it revokes the session.
       */
      expect(replayed.status).toBe(401)
      expect(gated.state.refreshReuseAttempts).toBe(1)
    } finally {
      await gated.close()
    }
  })
})

/**
 * The slash-command trio, pinned against `hermes serve` 0.21.3 as it answered
 * on 2026-09-21 (`tui_gateway/methods_tools.py` and `methods_complete.py`).
 *
 * This block exists because of a bug report, not a hunch. Slash autocomplete
 * shipped green: every test drove the fake, and the fake answered
 * `commands.catalog` with unslashed keys, `complete.slash` with slashed item
 * text and `replace_from: 0`, and `slash.exec` with one cheerful line for
 * ANYTHING — including the skills a real gateway refuses outright. The owner
 * typed `/` on a real gateway and saw nothing.
 *
 * So each case below names what upstream actually does, and the fake was
 * changed to match it rather than the other way round.
 */
describe('the slash trio over the socket — methods_tools.py + methods_complete.py', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** The whole frame, because half these cases are about the ERROR half. */
  const raw = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          // Resolve with the RESULT when there is one and with the whole frame
          // otherwise, so an error case can read `error.code`.
          waiter((frame.result ?? frame) as Record<string, unknown>)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  describe('commands.catalog — methods_tools.py::_Catalog', () => {
    it('keys every map WITH the slash, the way the accumulator writes them', async () => {
      const catalog = await call('commands.catalog', { session_id: 'bot-chat-writer', profile: 'writer' })

      for (const pair of catalog.pairs as string[][]) {
        expect(pair[0]).toMatch(/^\//u)
      }

      for (const key of Object.keys(catalog.canon as Record<string, string>)) {
        expect(key).toMatch(/^\//u)
      }

      for (const key of Object.keys(catalog.commands as Record<string, unknown>)) {
        expect(key).toMatch(/^\//u)
      }

      // `_catalog_skills` writes `cat.pairs.append([k, …])` with `k` already
      // slashed, and fills `skills[k]` under the same key.
      for (const key of Object.keys(catalog.skills as Record<string, unknown>)) {
        expect(key).toMatch(/^\//u)
      }
    })

    it('answers every key the accumulator returns, including the empty warning', () => {
      return call('commands.catalog', { session_id: 'bot-chat-writer' }).then(catalog => {
        expect(keysOf(catalog)).toEqual([
          'canon',
          'categories',
          'commands',
          'pairs',
          'skill_count',
          'skills',
          'sub',
          'warning'
        ])
        // `""` when nothing failed discovery — not absent, and not null.
        expect(catalog.warning).toBe('')
      })
    })

    /**
     * `skills[k]` is `{usage, origin}` and nothing else: every consumer ranks by
     * them. The fake used to put a `description` there, which is a field no
     * gateway sends and nothing could read.
     */
    it('describes a skill by usage and origin, not by a description', async () => {
      const catalog = await call('commands.catalog', {})
      const skills = catalog.skills as Record<string, Record<string, unknown>>

      for (const entry of Object.values(skills)) {
        expect(keysOf(entry)).toEqual(['origin', 'usage'])
      }

      expect(catalog.skill_count).toBe(Object.keys(skills).length)
    })

    /** `ArgumentMode` is `options | text | mixed` — or null. Never `required`. */
    it('uses upstream’s three-value argument_mode', async () => {
      const catalog = await call('commands.catalog', {})
      const commands = catalog.commands as Record<string, { argument_mode?: unknown }>

      for (const meta of Object.values(commands)) {
        expect([null, 'options', 'text', 'mixed']).toContain(meta.argument_mode ?? null)
      }
    })
  })

  describe('complete.slash — methods_complete.py', () => {
    /**
     * The single most load-bearing shape here. `c.text` is the completion's own
     * text with NO slash; the slash the reader typed is kept because
     * `replace_from` is 1 rather than 0. A client that accepted an item by
     * pasting `text` over the whole line would write `/` + `/model`.
     */
    it('answers unslashed text, slashed display, and replace_from 1', async () => {
      const result = await call('complete.slash', { text: '/mo', session_id: 'bot-chat-writer' })
      const items = result.items as { text: string; display: string; kind: string }[]

      expect(items.length).toBeGreaterThan(0)
      expect(result.replace_from).toBe(1)

      for (const item of items) {
        expect(item.text).not.toMatch(/^\//u)
        expect(item.display).toMatch(/^\//u)
        // `kind` rides only on slash completions: command vs skill.
        expect(['command', 'skill']).toContain(item.kind)
      }
    })

    /** Accepting an item has to rebuild the typed line without doubling it. */
    it('rebuilds the line the way the composer does', async () => {
      const typed = '/mo'
      const result = await call('complete.slash', { text: typed, session_id: 'bot-chat-writer' })
      const first = (result.items as { text: string }[])[0]!

      expect(`${typed.slice(0, result.replace_from as number)}${first.text}`).toBe('/model')
    })

    /** `text.rfind(" ") + 1` once there is an argument: the command is kept. */
    it('moves replace_from to the argument once there is one', async () => {
      const result = await call('complete.slash', { text: '/model ', session_id: 'bot-chat-writer' })

      expect(result.replace_from).toBe(7)
    })

    /** `if not text.startswith("/"): return {"items": []}` — and no replace_from. */
    it('answers nothing at all for a line that is not a command', async () => {
      const result = await call('complete.slash', { text: 'model', session_id: 'bot-chat-writer' })

      expect(result.items).toEqual([])
      expect(result.replace_from).toBeUndefined()
    })
  })

  describe('slash.exec — methods_tools.py::slash.exec', () => {
    /**
     * The refusal that broke the feature. Every skill in `commands.catalog`
     * answers `knowsSlashCommand` yes, and upstream's `_is_profile_skill_command`
     * guard refuses all of them here with 4018 — measured verbatim on the
     * reviewer gateway for `/docx`, `/pdf` and `/github`.
     */
    it('refuses a skill command and names the method that takes it', async () => {
      const frame = await raw('slash.exec', { session_id: 'bot-chat-writer', command: '/release-notes' })
      const error = frame.error as { code: number; message: string }

      expect(error.code).toBe(4018)
      expect(error.message).toContain('command.dispatch')
    })

    /**
     * `slash.exec` hands a rerouted built-in's DIRECTIVE straight back, so its
     * result can carry a `type` and no `output` at all. `/queue list` answers
     * `{type: 'send', message: 'list'}` on a real gateway: a client that reads
     * `output ?? message` renders the word `list` as though it were the result
     * and never queues anything.
     */
    it('can answer with a command.dispatch directive rather than output', async () => {
      const result = await call('slash.exec', { session_id: 'bot-chat-writer', command: '/queue write it up' })

      expect(result.type).toBe('send')
      expect(result.message).toBe('write it up')
      expect(result.output).toBeUndefined()
    })

    /** A worker command's text is a BLOCK, not a line. It needs somewhere to go. */
    it('answers a multi-line block for the commands that have one', async () => {
      const result = await call('slash.exec', { session_id: 'bot-chat-writer', command: '/status' })

      expect(String(result.output).split('\n').length).toBeGreaterThan(3)
    })
  })

  describe('command.dispatch — methods_tools.py::command.dispatch', () => {
    /**
     * `display` is the line a UI renders; `message` is the expanded skill body,
     * which is model-facing scaffolding no surface may show.
     */
    it('answers a skill as a directive with a display and a message', async () => {
      const result = await call('command.dispatch', {
        name: 'release-notes',
        arg: 'for 1.2',
        session_id: 'bot-chat-writer'
      })

      expect(result.type).toBe('skill')
      expect(result.display).toBe('/release-notes for 1.2')
      expect(String(result.message).length).toBeGreaterThan(String(result.display).length)
    })

    it('answers a prefill with the text the composer is meant to take', async () => {
      const result = await call('command.dispatch', { name: 'undo', session_id: 'bot-chat-writer' })

      expect(result.type).toBe('prefill')
      expect(typeof result.message).toBe('string')
    })
  })
})

/**
 * The one key whose values are NOT the boolean words every other switch takes.
 *
 * This is the shape a whole feature was lost to: the options sheet sent
 * `true`/`false` for fast mode because that is what the yolo switch next to it
 * sends, upstream parses this key against `_FAST_WORDS` instead, and every tap
 * came back 4002. The fake stored whatever it was handed, so the suite agreed
 * with the app and both were wrong about the gateway.
 */
describe('config.set fast — methods_config_set.py::_set_fast', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  /** The whole frame: half of these cases are about the ERROR half of it. */
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  /** A stored session id the server will actually resolve and write against. */
  const storedIdOf = async (profile: string): Promise<string> => {
    const frame = await call('profiles.list', { include_sessions: true })
    const profiles = (frame.result as Record<string, unknown>).profiles as Record<string, unknown>[]
    const row = profiles.find(entry => entry.name === profile)
    const stored = String((row?.canonical_session as Record<string, unknown> | undefined)?.id ?? '')

    expect(stored).not.toBe('')

    return stored
  }

  let session = ''

  beforeAll(async () => {
    session = await storedIdOf('writer')
  })

  it('refuses `true` with 4002, the way upstream refuses a word it does not know', async () => {
    const frame = await call('config.set', { key: 'fast', value: 'true', session_id: session })

    expect(frame.result).toBeUndefined()
    expect(frame.error).toMatchObject({ code: 4002, message: 'unknown fast mode: true' })
  })

  it('takes the words the gateway takes, and reads them back as a mode', async () => {
    for (const [sent, stored] of [
      ['fast', 'fast'],
      ['on', 'fast'],
      ['normal', 'normal'],
      ['off', 'normal']
    ]) {
      const set = await call('config.set', { key: 'fast', value: sent, session_id: session })

      expect(set.error).toBeUndefined()

      const read = await call('config.get', { key: 'fast', session_id: session })

      expect((read.result as Record<string, unknown>).value).toBe(stored)
    }
  })

  it('reports a session nobody has switched as `normal`, never as blank', async () => {
    const read = await call('config.get', { key: 'fast', session_id: await storedIdOf('researcher') })

    expect((read.result as Record<string, unknown>).value).toBe('normal')
  })

  /**
   * The neighbour that made the defect above so easy to miss. `yolo` is parsed
   * against `_BOOL_WORDS`, which really does take `true` — so the sheet's
   * `true`/`false` was right here and wrong one row up.
   */
  it('takes every boolean word upstream takes for yolo, and reports it back switched on', async () => {
    for (const word of ['1', 'on', 'true', 'yes']) {
      const set = await call('config.set', { key: 'yolo', value: word, session_id: session })
      const result = set.result as Record<string, unknown>

      expect(set.error).toBeUndefined()
      // The value is echoed as it was sent; what it MEANS is reported on the
      // session, which is where a client reads it back.
      expect(result.value).toBe(word)
      expect((result.info as Record<string, unknown>).yolo).toBe(true)
    }

    for (const word of ['0', 'off', 'false', 'no']) {
      const set = await call('config.set', { key: 'yolo', value: word, session_id: session })

      expect(set.error).toBeUndefined()
      expect(((set.result as Record<string, unknown>).info as Record<string, unknown>).yolo).toBe(false)
    }
  })
})

/**
 * The three calls a bot-profile editor makes, pinned against the CONTRACT.
 *
 * Unlike the REST cases above there is no vendored handler to read: the profile
 * RPCs live behind `tui_gateway/contracts`, and what a client is held to is the
 * declaration the generator emits from it —
 * `ProfilesConfigureParams/Result/Applied`, `ProfilesSetAssetParams/Result` and
 * `ProfilesGetAssetParams/Result` in
 * `packages/hermes-shared/src/gateway-contract.generated.ts`. So these cases
 * name the type they were read from rather than a Python file nobody here has
 * open, and they check WHICH KEYS come back and what type each one is: an
 * editor that stores a picture the roster cannot find again fails on the shape
 * long before it fails on the bytes.
 */
describe('profiles.set_asset / get_asset over the socket — tui_gateway/contracts::ProfilesSetAssetResult', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  /** The whole frame, so a refusal can be read as one rather than as a result. */
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const resultOf = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const frame = await call(method, params)

    expect(frame.error).toBeUndefined()

    return frame.result as Record<string, unknown>
  }

  /** The avatar revision as the roster reports it — the number a client re-fetches on. */
  const avatarRevisionOf = async (name: string): Promise<number> => {
    const roster = await resultOf('profiles.list')
    const row = (roster.profiles as Record<string, unknown>[]).find(entry => entry.name === name)

    return (row?.ui_meta_revisions as Record<string, number> | undefined)?.avatar ?? 0
  }

  /** A four-byte JPEG: enough magic for the sniff, and not the staged PNG. */
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb])

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  it('answers a write with `ok`, the asset it wrote, and the DECODED byte count', async () => {
    // The writer is the profile staged WITHOUT a picture, so nothing here can
    // pass on the fixture the researcher carries.
    const wrote = await resultOf('profiles.set_asset', {
      name: 'writer',
      asset: 'avatar',
      data: `data:image/jpeg;base64,${jpegBytes.toString('base64')}`
    })

    expect(keysOf(wrote)).toEqual(['asset', 'ok', 'size'])
    expect(wrote.ok).toBe(true)
    expect(wrote.asset).toBe('avatar')
    // Bytes, not base64 characters: `size` is what the gateway stored, and the
    // encoded form is a third longer than that.
    expect(wrote.size).toBe(jpegBytes.length)
  })

  it('takes bare base64 as well as a data URL, and counts the same bytes for both', async () => {
    const bare = await resultOf('profiles.set_asset', {
      name: 'writer',
      asset: 'avatar',
      data: jpegBytes.toString('base64')
    })

    expect(bare.size).toBe(jpegBytes.length)
  })

  it('reads the written picture back, as the four keys `ProfilesGetAssetResult` declares', async () => {
    const read = await resultOf('profiles.get_asset', { name: 'writer', asset: 'avatar' })

    expect(keysOf(read)).toEqual(['data', 'found', 'mime', 'size'])
    expect(read.found).toBe(true)
    expect(read.size).toBe(jpegBytes.length)
    // Sniffed from the bytes, so it is a JPEG here and not the staged PNG this
    // profile would have answered if the write had gone nowhere.
    expect(read.mime).toBe('image/jpeg')
    expect(read.data).toBe(`data:image/jpeg;base64,${jpegBytes.toString('base64')}`)
  })

  it('moves `ui_meta_revisions.avatar` on a write, because that is the cache-buster', async () => {
    const before = await avatarRevisionOf('writer')

    await resultOf('profiles.set_asset', { name: 'writer', asset: 'avatar', data: jpegBytes.toString('base64') })

    expect(await avatarRevisionOf('writer')).toBe(before + 1)
  })

  it('clears a picture with `removed`, and moves the revision for that too', async () => {
    const before = await avatarRevisionOf('writer')
    const cleared = await resultOf('profiles.set_asset', { name: 'writer', asset: 'avatar', clear: true })

    expect(keysOf(cleared)).toEqual(['asset', 'ok', 'removed'])
    expect(cleared.ok).toBe(true)
    expect(cleared.asset).toBe('avatar')
    expect(cleared.removed).toBe(1)
    // A removal is a write: a client still holding the old picture has to be
    // told to look again, or it goes on drawing a face nobody has any more.
    expect(await avatarRevisionOf('writer')).toBe(before + 1)
  })

  it('answers `found: false` and nothing else once the picture is gone', async () => {
    const read = await resultOf('profiles.get_asset', { name: 'writer', asset: 'avatar' })

    expect(keysOf(read)).toEqual(['found'])
    expect(read.found).toBe(false)
  })

  it('counts nothing removed when there was nothing there', async () => {
    const again = await resultOf('profiles.set_asset', { name: 'writer', asset: 'avatar', clear: true })

    expect(again.removed).toBe(0)
  })

  it('still answers the staged picture for a profile nobody has written to', async () => {
    const read = await resultOf('profiles.get_asset', { name: 'researcher', asset: 'avatar' })

    expect(read.found).toBe(true)
    expect(read.mime).toBe('image/png')
    expect(String(read.data)).toMatch(/^data:image\/png;base64,/u)
  })

  it('refuses a profile it does not have rather than inventing one', async () => {
    const frame = await call('profiles.set_asset', { name: 'nobody', asset: 'avatar', clear: true })

    expect(frame.result).toBeUndefined()
    expect(String((frame.error as Record<string, unknown>).message)).toMatch(/Unknown profile/u)
  })
})

describe('profiles.configure description — tui_gateway/contracts::ProfilesConfigureApplied', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const descriptionOf = async (name: string): Promise<unknown> => {
    const roster = (await call('profiles.list')).result as Record<string, unknown>

    return (roster.profiles as Record<string, unknown>[]).find(row => row.name === name)?.description
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  it('writes the line the roster shows, and reports the section on its own', async () => {
    const frame = await call('profiles.configure', { name: 'writer', description: 'Writes the announcements.' })
    const result = frame.result as Record<string, unknown>
    const applied = result.applied as Record<string, unknown>

    expect(frame.error).toBeUndefined()
    expect(result.ok).toBe(true)
    // Only the section the request carried: a `ui_meta` key here would mean the
    // fake had reported on a bag the request never mentioned.
    expect(keysOf(applied)).toEqual(['description'])
    expect(applied.description).toBe(true)
    expect(await descriptionOf('writer')).toBe('Writes the announcements.')
  })

  it('keeps the line out of the ui_meta bag, because it is a column of its own', async () => {
    const roster = (await call('profiles.list')).result as Record<string, unknown>
    const row = (roster.profiles as Record<string, unknown>[]).find(entry => entry.name === 'writer')

    expect(Object.keys((row?.ui_meta as Record<string, unknown>) ?? {})).not.toContain('description')
  })

  it('reports both sections when one request carries both', async () => {
    const frame = await call('profiles.configure', {
      name: 'researcher',
      description: 'Finds the sources.',
      ui_meta: { hermie: { colour: 'teal' } }
    })
    const applied = (frame.result as Record<string, unknown>).applied as Record<string, unknown>

    expect(keysOf(applied)).toEqual(['description', 'ui_meta', 'ui_meta_revisions'])
    expect(applied.description).toBe(true)
    expect(applied.ui_meta).toBe(true)
    expect((applied.ui_meta_revisions as Record<string, number>).hermie).toBe(1)
    expect(await descriptionOf('researcher')).toBe('Finds the sources.')
  })

  it('leaves the line alone for a request that carries no description at all', async () => {
    const frame = await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { colour: 'amber' } } })
    const applied = (frame.result as Record<string, unknown>).applied as Record<string, unknown>

    expect(applied).not.toHaveProperty('description')
    expect(await descriptionOf('researcher')).toBe('Finds the sources.')
  })
})

/**
 * Retiring a conversation and minting its successor, over the socket.
 *
 * Three methods this fake did not model at all until `/new` needed them, and the
 * reason they are pinned here rather than only in the app's own suite is that
 * two of them are mostly REFUSALS. A fake that says yes to everything would have
 * let the obvious implementation through — create the new chat, then rename the
 * old one — and a real gateway refuses that in a way no green suite would have
 * predicted.
 *
 * Upstream: `tui_gateway/methods_session.py` for the three methods, and
 * `hermes_state_titles.py::_set_session_title` for both title refusals.
 */
describe('session.title / set_hidden / close over the socket — methods_session.py', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  /** The whole frame: half of what is asserted here is the `error` half. */
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const botChatOf = async (profile: string): Promise<Record<string, unknown>> => {
    const listed = await call('session.list', { profile, title: 'Bot Chat', include_hidden: true })

    return ((listed.result as { sessions: Record<string, unknown>[] }).sessions[0] ?? {}) as Record<string, unknown>
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  /**
   * A canonical chat is out of the default listing. `include_hidden` is not a
   * convenience on this lookup — without it the bot has no chat.
   */
  it('keeps a hidden Bot Chat out of session.list until it is asked for', async () => {
    const plain = await call('session.list', { profile: 'writer', title: 'Bot Chat' })
    const asked = await call('session.list', { profile: 'writer', title: 'Bot Chat', include_hidden: true })

    expect((plain.result as { sessions: unknown[] }).sessions).toHaveLength(0)
    expect((asked.result as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  /**
   * `session.title` is session-scoped — `_with_db(session_scoped=True)` over
   * `_sess_nowait`, a plain lookup in the live `_sessions` map. A stored id
   * resolves perfectly well for `session.list`, `session.resume` and REST, and
   * comes back 4001 here.
   */
  it('takes the runtime id and refuses a stored one with 4001', async () => {
    const chat = await botChatOf('writer')
    const stored = await call('session.title', { session_id: String(chat.id), title: 'whatever' })

    expect(stored.error).toMatchObject({ code: 4001 })
  })

  /**
   * The refusal that decides the whole shape of `/new`: a HIDDEN session called
   * `Bot Chat` may not be renamed off that title, because the title is how Bot
   * Mode finds the conversation again.
   */
  it('refuses to rename a hidden Bot Chat, and takes the rename once it is visible', async () => {
    const chat = await botChatOf('writer')
    const resumed = await call('session.resume', { session_id: String(chat.id), omit_messages: true })
    const runtime = String((resumed.result as { session_id: string }).session_id)

    const guarded = await call('session.title', { session_id: runtime, title: 'Bot Chat · 2026-09-21 23:16' })

    expect(guarded.error).toMatchObject({ code: 4022 })
    expect(String((guarded.error as { message: string }).message)).toContain('canonical Bot Chat')

    await call('session.set_hidden', { session_id: runtime, hidden: false })

    const renamed = await call('session.title', { session_id: runtime, title: 'Bot Chat · 2026-09-21 23:16' })

    expect(renamed.result).toMatchObject({ pending: false, title: 'Bot Chat · 2026-09-21 23:16' })

    // And the title is now free, which is what a second `Bot Chat` needs.
    const free = await call('session.list', { profile: 'writer', title: 'Bot Chat', include_hidden: true })

    expect((free.result as { sessions: unknown[] }).sessions).toHaveLength(0)
  })

  /**
   * `_set_session_title`'s other refusal: a title is unique — ON A PROFILE.
   *
   * The scope is an inference rather than a probe, and it is the one this whole
   * app rests on: ADR-0007's canonical chat is the session titled exactly
   * `Bot Chat`, and every bot has one, so the uniqueness cannot be across the
   * gateway or Bot Mode would work for a single profile. The case below it
   * pins the other half of that reading. See `docs/platform-notes.md`.
   */
  it('refuses a title another session on the same profile already holds', async () => {
    // Two ordinary sessions on ONE profile, so the clash is unambiguously
    // within it rather than borrowed from whatever another test renamed.
    await call('session.create', { profile: 'notes', title: 'Clash probe A', hidden: false })
    const second = await call('session.create', { profile: 'notes', title: 'Clash probe B', hidden: false })
    const stored = String((second.result as { stored_session_id: string }).stored_session_id)
    const resumed = await call('session.resume', { session_id: stored, omit_messages: true })
    const runtime = String((resumed.result as { session_id: string }).session_id)

    const clash = await call('session.title', { session_id: runtime, title: 'Clash probe A' })

    expect(clash.error).toMatchObject({ code: 4022 })
    expect(String((clash.error as { message: string }).message)).toContain('already in use')
  })

  /**
   * And the other half: two PROFILES may hold the same title at once.
   *
   * The fixtures already prove it — `researcher`, `writer` and `notes` are each
   * born with a `Bot Chat` — so a `session.create` that refused the second one
   * would be refusing something this gateway ships. Round R10b's per-user chats
   * need the same of `Chat · <name>`, which is one title across every bot a
   * person talks to.
   */
  it('lets two profiles hold one title, the way every bot holds Bot Chat', async () => {
    const mine = 'Chat · Fake Tester'

    const first = await call('session.create', { profile: 'researcher', title: mine, hidden: false })
    const second = await call('session.create', { profile: 'notes', title: mine, hidden: false })

    expect((first.result as { stored_session_id: string }).stored_session_id).toBeTruthy()
    expect((second.result as { stored_session_id: string }).stored_session_id).toBeTruthy()

    for (const profile of ['researcher', 'notes']) {
      const listed = await call('session.list', { profile, title: mine, include_hidden: true })

      expect((listed.result as { sessions: { title?: string }[] }).sessions).toHaveLength(1)
      expect((listed.result as { sessions: { title?: string }[] }).sessions[0]?.title).toBe(mine)
    }
  })

  /**
   * `session.close` pops the RUNTIME session and leaves the stored row alone.
   * The transcript survives; the runtime id does not, and a resume of the stored
   * id builds a new one.
   */
  it('closes the runtime session, keeps the transcript, and resumes under a new runtime id', async () => {
    const chat = await botChatOf('researcher')
    const first = await call('session.resume', { session_id: String(chat.id), omit_messages: true })
    const runtime = String((first.result as { session_id: string }).session_id)

    expect((await call('session.close', { session_id: runtime })).result).toMatchObject({ closed: true })

    // Every session-scoped RPC still holding the old id is now answered 4001.
    expect((await call('session.title', { session_id: runtime, title: 'x' })).error).toMatchObject({ code: 4001 })

    const again = await call('session.resume', { session_id: String(chat.id), omit_messages: true })
    const result = again.result as { session_id: string; message_count: number }

    expect(result.session_id).not.toBe(runtime)
    expect(result.message_count).toBeGreaterThan(0)
  })

  /**
   * `profiles.list` resolves the canonical chat by title on every call
   * (`methods_profiles.py::_canonical_session_row` → `get_session_by_title`),
   * so a profile whose chat has been renamed away reports none at all. A client
   * that leans on the roster to tell it where a bot's chat is has to survive
   * that window; `/new` opens one every time it runs.
   */
  it('reports no canonical session for a profile whose Bot Chat has been renamed away', async () => {
    const listed = await call('profiles.list', {})
    const profiles = (listed.result as { profiles: Record<string, unknown>[] }).profiles
    const writer = profiles.find(profile => profile.name === 'writer')
    const researcher = profiles.find(profile => profile.name === 'researcher')

    // `writer`'s chat was renamed above; `researcher`'s rename was refused.
    expect(writer?.canonical_session).toBeUndefined()
    expect(researcher?.canonical_session).toMatchObject({ title: 'Bot Chat' })
  })
})

/**
 * `session.branch` and `session.delete`, and the honest size of what is known.
 *
 * These two are pinned in a describe of their own with a gateway of their own,
 * because the block above deliberately leaves `writer`'s chat renamed and a
 * branch test that inherited that state would be asserting about the wrong
 * thing.
 *
 * **What the contract says, in full.** `session.branch` is described upstream as
 * "Fork a live session into a new stored child that shares the parent's history
 * so far", and takes `{session_id, profile?, name?, count?}`. `session.delete`
 * takes `{session_id, profile?}` and its own doc comment is "``session_id`` is
 * the STORED id". That is all of it — there is no row index, no row id, and no
 * statement anywhere of what `count` counts.
 *
 * So one assertion below (`count` as a message count taken from the start) is
 * this app's READING of the parameter rather than a fact read off a handler, and
 * it is marked as such where it appears. The rest — which id each method takes,
 * that a branch is visible, that the parent is untouched — follows from
 * sentences upstream actually writes.
 */
describe('session.branch / session.delete — methods_session.py, and one assumption', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const ok = <T>(frame: Record<string, unknown>): T => frame.result as T

  /** The canonical chat's stored row, and a runtime id for it. */
  const liveBotChat = async (profile: string): Promise<{ stored: string; runtime: string }> => {
    const listed = await call('session.list', { profile, title: 'Bot Chat', include_hidden: true })
    const stored = String(ok<{ sessions: { id: string }[] }>(listed).sessions[0]?.id ?? '')
    const resumed = await call('session.resume', { session_id: stored, omit_messages: true })

    return { stored, runtime: String(ok<{ session_id: string }>(resumed).session_id) }
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  /**
   * "Fork a LIVE session." Every session-scoped method upstream resolves through
   * `_sess_nowait`, a plain lookup in the live `_sessions` map, so a stored id —
   * which `session.list`, `session.resume` and the REST routes all accept — is
   * 4001 here. This is the same rule `session.title` is held to above.
   */
  it('takes the runtime id and refuses a stored one with 4001', async () => {
    const { stored } = await liveBotChat('writer')

    expect((await call('session.branch', { session_id: stored, name: 'Branch · nope' })).error).toMatchObject({
      code: 4001
    })
  })

  it('answers the seven fields SessionBranchResult declares', async () => {
    const { runtime, stored } = await liveBotChat('writer')
    const branched = await call('session.branch', { session_id: runtime, name: 'Branch · the shape' })
    const result = ok<Record<string, unknown>>(branched)

    expect(keysOf(result)).toEqual([
      'info',
      'message_count',
      'messages',
      'parent',
      'session_id',
      'stored_session_id',
      'title'
    ])
    // Two DIFFERENT ids, exactly as a resume reports: the runtime one is the
    // live child, the stored one is the durable row a listing hands out.
    expect(result.session_id).not.toBe(result.stored_session_id)
    expect(result.parent).toBe(stored)
    expect(result.title).toBe('Branch · the shape')
  })

  /**
   * **The assumption.** `count` is the only parameter that can express a
   * position and nothing upstream says what it counts; the app reads it as "how
   * many of the parent's messages the child starts with" and this handler agrees
   * with the app. If a real gateway ever says otherwise, this assertion and
   * `ChatController.branchFrom` are the two places that change.
   */
  it('starts the child with `count` of the parent’s messages, counted from the start', async () => {
    const { runtime } = await liveBotChat('researcher')
    const parent = ok<{ count: number }>(await call('session.history', { session_id: runtime }))
    const branched = await call('session.branch', { session_id: runtime, name: 'Branch · two rows', count: 2 })
    const result = ok<{ message_count: number; stored_session_id: string }>(branched)

    expect(parent.count).toBeGreaterThan(2)
    expect(result.message_count).toBe(2)

    // And the copy is a COPY: the two conversations diverge from here, which is
    // the whole point of a branch.
    const child = ok<{ count: number }>(await call('session.history', { session_id: result.stored_session_id }))

    expect(child.count).toBe(2)
  })

  it('carries the parent’s whole history when no count is given', async () => {
    const { runtime } = await liveBotChat('researcher')
    const parent = ok<{ count: number }>(await call('session.history', { session_id: runtime }))
    const branched = await call('session.branch', { session_id: runtime, name: 'Branch · everything' })

    expect(ok<{ message_count: number }>(branched).message_count).toBe(parent.count)
  })

  /**
   * Nothing in the parameters can ask for a hidden child, and a branch that
   * arrived hidden would be a conversation the reader could not find. This is
   * what lets the app's Branches group list without `include_hidden`.
   */
  it('makes an ordinary VISIBLE session of the same profile, leaving the parent alone', async () => {
    const { runtime, stored } = await liveBotChat('researcher')
    const branched = await call('session.branch', { session_id: runtime, name: 'Branch · visible' })
    const childId = ok<{ stored_session_id: string }>(branched).stored_session_id

    const plain = ok<{ sessions: { id: string }[] }>(await call('session.list', { profile: 'researcher' }))

    expect(plain.sessions.map(row => row.id)).toContain(childId)

    // The parent is still the hidden canonical chat it was.
    const canonical = ok<{ sessions: { id: string }[] }>(
      await call('session.list', { profile: 'researcher', title: 'Bot Chat', include_hidden: true })
    )

    expect(canonical.sessions.map(row => row.id)).toEqual([stored])
  })

  /**
   * `_set_session_title` refuses a duplicate, and `session.create` models the
   * same thing: the create succeeds and the NAME does not land. A client that
   * assumed otherwise would go looking for its branch under a title nothing
   * holds — which is why `ChatController.branchFrom` reports the title the
   * gateway settled on rather than the one it asked for.
   */
  it('still creates the branch when the name is already worn, without taking the name', async () => {
    const { runtime } = await liveBotChat('writer')

    await call('session.branch', { session_id: runtime, name: 'Branch · taken' })

    const second = await call('session.branch', { session_id: runtime, name: 'Branch · taken' })

    expect(ok<{ stored_session_id: string }>(second).stored_session_id).toBeTruthy()
    expect(ok<{ title: string }>(second).title).not.toBe('Branch · taken')
  })

  /**
   * The opposite id to `session.title` next door, and the contract says so in
   * one line: "``session_id`` is the STORED id". A client reaching for the
   * runtime id it happens to be holding finds out here rather than against
   * somebody's real gateway.
   */
  it('deletes by the STORED id, answers `{deleted}`, and 4001s a runtime one', async () => {
    const { runtime } = await liveBotChat('writer')
    const branched = await call('session.branch', { session_id: runtime, name: 'Branch · doomed' })
    const child = ok<{ session_id: string; stored_session_id: string }>(branched)

    expect((await call('session.delete', { session_id: child.session_id })).error).toMatchObject({ code: 4001 })

    const deleted = await call('session.delete', { session_id: child.stored_session_id })

    expect(keysOf(ok<Record<string, unknown>>(deleted))).toEqual(['deleted'])
    expect(ok<{ deleted: string }>(deleted).deleted).toBe(child.stored_session_id)

    const listed = ok<{ sessions: { id: string }[] }>(await call('session.list', { profile: 'writer' }))

    expect(listed.sessions.map(row => row.id)).not.toContain(child.stored_session_id)
  })

  /**
   * **No canonical guard, and that is deliberate.** It would be easy to make the
   * fake refuse to delete a hidden `Bot Chat`, and comforting to have it catch
   * the mistake — and it would be a fake that lies, because upstream documents
   * no such refusal. The rule that the canonical chat is never deleted is the
   * APP's: `conversationActions` answers an empty action list for it, and
   * `expo/hermie/__tests__/session-branch.test.ts` is where that is proved.
   */
  it('does NOT invent a refusal upstream does not document for the canonical chat', async () => {
    const { stored } = await liveBotChat('researcher')

    expect(ok<{ deleted: string }>(await call('session.delete', { session_id: stored })).deleted).toBe(stored)
  })

  it('4001s a stored id nothing holds', async () => {
    expect((await call('session.delete', { session_id: 'stored-nothing' })).error).toMatchObject({ code: 4001 })
  })
})

describe('session.usage over the socket — server.py::_get_usage + agent/context_breakdown.py', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          // The RESULT where there is one and the whole frame otherwise, so the
          // refusal case below can read `error`.
          waiter((frame.result ?? frame) as Record<string, unknown>)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterAll(async () => {
    socket.close()
    await live.close()
  })

  const storedId = async (): Promise<string> => {
    const profiles = (await call('profiles.list', { include_sessions: true })).profiles as Record<string, unknown>[]
    const researcher = profiles.find(row => row.name === 'researcher')

    return String((researcher?.canonical_session as Record<string, unknown> | undefined)?.id ?? '')
  }

  /**
   * The two fields the app will not draw a ring without.
   *
   * `SessionUsageResult` in the contract marks every field optional, which is
   * true of the wire and useless as a guarantee — so this pins that the fake
   * sends the PAIR rather than only the token counts. A fake that answered
   * `{total}` alone would make every test of that surface a test of the empty
   * case, and the surface would look covered.
   */
  it('reports the window beside the token counts', async () => {
    const stored = await storedId()

    expect(stored).not.toBe('')

    const usage = await call('session.usage', { session_id: stored })

    expect(typeof usage.context_used).toBe('number')
    expect(typeof usage.context_max).toBe('number')
    expect(usage.context_max as number).toBeGreaterThan(usage.context_used as number)
    expect(typeof usage.total).toBe('number')
  })

  /** A resume carries the same reading inside `info`, which is the cold-open path. */
  it('puts the same reading on the resume snapshot', async () => {
    const stored = await storedId()
    const resumed = await call('session.resume', { session_id: stored })
    const info = resumed.info as Record<string, unknown>
    const usage = info.usage as Record<string, unknown>

    expect(typeof usage?.context_max).toBe('number')
    expect(usage?.context_used).toBe((await call('session.usage', { session_id: stored })).context_used)
  })

  it('refuses a session it does not have, rather than answering zero', async () => {
    const frame = await call('session.usage', { session_id: 'no-such-session' })

    expect(frame.error).toBeTruthy()
  })
})

/**
 * One socket, opened per `describe` that wants one.
 *
 * The blocks above each grew their own copy of this, which was fine while there
 * were two of them. The families below would have made eight, so it is a
 * function now — and deliberately still returns a bare `call` rather than
 * anything clever, because a shape test that needs a helper to express what it
 * asserts has stopped being readable as a record of what upstream does.
 */
function socketHarness(): {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** The live gateway's mutable state, for a case that has to arrange one. */
  state: () => FakeGateway['state']
  open: () => Promise<void>
  close: () => Promise<void>
} {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  return {
    call: (method, params = {}) => {
      const id = ++nextId

      return new Promise<Record<string, unknown>>(resolve => {
        pending.set(id, resolve)
        socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    state: () => live.state,
    open: async () => {
      live = await startFakeGateway({ port: 0 })
      socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

      socket.on('message', data => {
        for (const line of String(data).split('\n')) {
          if (!line.trim()) {
            continue
          }

          const frame = JSON.parse(line) as Record<string, unknown>
          const id = typeof frame.id === 'number' ? frame.id : null
          const waiter = id === null ? undefined : pending.get(id)

          if (waiter && id !== null) {
            pending.delete(id)
            waiter(frame)
          }
        }
      })

      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
    },
    close: async () => {
      socket.close()
      await live.close()
    }
  }
}

/**
 * Making a bot, over the socket.
 *
 * Upstream: `tui_gateway/methods_profiles.py::profiles.create`, which delegates
 * its validation to `hermes_cli/profiles.py::create_profile` → `_canon_valid` →
 * `validate_profile_name` → `hermes_constants.PROFILE_ID_RE`.
 *
 * The refusals are most of what is worth pinning. Three different bad names
 * produce three different errors upstream, and the app shows each of them in a
 * form field before it sends anything — so if the fake collapsed them into one,
 * `profile-name.test.ts` would be asserting against a rule nobody shares.
 *
 * The other half is what create does NOT do: it writes a profile directory and
 * stops. No canonical chat is minted, which is why the roster row comes back
 * without `canonical_session` and ADR-0007's resolve-then-create is still the
 * only thing standing between a new bot and a forked conversation.
 */
describe('profiles.create over the socket — methods_profiles.py::profiles.create', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  it('answers the six keys the contract declares, with `mirrored` as an object', async () => {
    const frame = await harness.call('profiles.create', { name: 'scout', description: 'Looks ahead.' })
    const result = frame.result as Record<string, unknown>

    expect(frame.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.name).toBe('scout')
    expect(typeof result.path).toBe('string')
    expect(typeof result.soul_written).toBe('boolean')
    expect(typeof result.model_set).toBe('boolean')
    expect(typeof result.mirrored).toBe('object')
  })

  /**
   * `_mirror_launch_credentials` defaults `mirror_credentials` to TRUE, and the
   * docstring says why: a bare `create_profile()` seeds a comment-only `.env`
   * and no `auth.json`, which is a bot with no provider at all. A client that
   * sent `mirror_credentials: false` to be tidy would make an unusable bot.
   */
  it('mirrors the launch credentials unless told not to', async () => {
    const mirrored = ((await harness.call('profiles.create', { name: 'tidy' })).result as Record<string, unknown>)
      .mirrored as Record<string, unknown>

    expect(mirrored.env).toBe(true)
    expect(mirrored.model_inherited).toBe(true)

    const bare = (
      (await harness.call('profiles.create', { name: 'bare', mirror_credentials: false })).result as Record<
        string,
        unknown
      >
    ).mirrored as Record<string, unknown>

    expect(bare.env).toBe(false)
  })

  /** `share_auth` reports the string `"shared"`, not a boolean — it skips the copy. */
  it('reports shared auth as a word rather than a flag', async () => {
    const mirrored = (
      (await harness.call('profiles.create', { name: 'shared-bot', share_auth: true })).result as Record<
        string,
        unknown
      >
    ).mirrored as Record<string, unknown>

    expect(mirrored.auth).toBe('shared')
  })

  it('leaves the new bot without a canonical chat, so the client resolves one', async () => {
    await harness.call('profiles.create', { name: 'fresh' })

    const roster = (await harness.call('profiles.list')).result as Record<string, unknown>
    const row = (roster.profiles as Record<string, unknown>[]).find(entry => entry.name === 'fresh')

    expect(row).toBeTruthy()
    expect(row?.canonical_session).toBeUndefined()
  })

  it('refuses an empty name with 4061, which is its own code', async () => {
    const frame = await harness.call('profiles.create', { name: '   ' })

    expect((frame.error as Record<string, unknown>)?.code).toBe(4061)
  })

  it('refuses a name the pattern rejects, and quotes the rule', async () => {
    const error = (await harness.call('profiles.create', { name: 'my bot' })).error as Record<string, unknown>

    expect(error?.code).toBe(4062)
    expect(String(error?.message)).toContain('lowercase letters')
  })

  it('refuses a reserved name as reserved', async () => {
    const error = (await harness.call('profiles.create', { name: 'sudo' })).error as Record<string, unknown>

    expect(String(error?.message)).toContain('reserved')
  })

  /**
   * `default` is in `_RESERVED_NAMES` and yet never reaches the reserved
   * branch: `validate_profile_name` returns early for it and `create_profile`
   * refuses it separately as the built-in profile. Two names, two sentences.
   */
  it('refuses `default` as the built-in rather than as a reserved word', async () => {
    const message = String(
      ((await harness.call('profiles.create', { name: 'default' })).error as Record<string, unknown>)?.message
    )

    expect(message).toContain('built-in')
    expect(message).not.toContain('reserved')
  })

  it('refuses a second bot with a name that is taken', async () => {
    await harness.call('profiles.create', { name: 'twin' })

    const error = (await harness.call('profiles.create', { name: 'twin' })).error as Record<string, unknown>

    expect(String(error?.message)).toContain('already exists')
  })

  it('refuses to clone from a bot that is not there', async () => {
    const error = (await harness.call('profiles.create', { name: 'orphan', clone_from: 'nobody' })).error as Record<
      string,
      unknown
    >

    expect(error?.code).toBe(4062)
  })
})

/**
 * The editor snapshot, over the socket.
 *
 * Upstream: `methods_profiles.py::profiles.describe` and `_describe_toolsets`.
 *
 * Two of these shapes are inverted or conditional in a way that reads wrong at
 * a glance, and both would produce a switch list that is exactly backwards:
 * `skills` reports `enabled` although the gateway STORES the disabled set, and
 * `toolsets_pinned` reports whether a pin exists rather than whether anything
 * is enabled.
 */
describe('profiles.describe over the socket — methods_profiles.py::profiles.describe', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  it('answers the editor keys, with the model pin as an object', async () => {
    const result = (await harness.call('profiles.describe', { name: 'researcher' })).result as Record<string, unknown>

    expect(keysOf(result)).toEqual([
      'description',
      'mcp_servers',
      'model',
      'name',
      'skills',
      'soul',
      'toolsets',
      'toolsets_pinned'
    ])
    expect(keysOf(result.model)).toEqual(['default', 'provider'])
  })

  it('reports skills as {name, enabled}, which is the complement of what is stored', async () => {
    const result = (await harness.call('profiles.describe', { name: 'writer' })).result as Record<string, unknown>
    const skills = result.skills as { name: string; enabled: boolean }[]

    expect(skills.find(skill => skill.name === 'pdf')?.enabled).toBe(false)
    expect(skills.find(skill => skill.name === 'docx')?.enabled).toBe(true)
  })

  it('carries a label, a description and a tool count on every toolset row', async () => {
    const toolsets = (
      (await harness.call('profiles.describe', { name: 'researcher' })).result as Record<string, unknown>
    ).toolsets as Record<string, unknown>[]

    expect(toolsets.length).toBeGreaterThan(0)

    for (const toolset of toolsets) {
      expect(typeof toolset.name).toBe('string')
      expect(typeof toolset.label).toBe('string')
      expect(typeof toolset.description).toBe('string')
      expect(typeof toolset.tool_count).toBe('number')
      expect(typeof toolset.enabled).toBe('boolean')
    }
  })

  /**
   * The distinction the whole section turns on. An unpinned profile still
   * reports enabled toolsets — the platform defaults — so a client that read
   * `toolsets_pinned: false` as "nothing is on" would draw every switch off and
   * then write that back.
   */
  it('separates having no pin from having nothing enabled', async () => {
    const unpinned = (await harness.call('profiles.describe', { name: 'researcher' })).result as Record<string, unknown>

    expect(unpinned.toolsets_pinned).toBe(false)
    expect((unpinned.toolsets as { enabled: boolean }[]).some(toolset => toolset.enabled)).toBe(true)

    const pinned = (await harness.call('profiles.describe', { name: 'writer' })).result as Record<string, unknown>

    expect(pinned.toolsets_pinned).toBe(true)
  })

  /**
   * `_describe_toolsets` drops a `_DEFAULT_OFF_TOOLSETS` entry entirely while it
   * is off, so the list is not a constant: enabling one makes a row appear that
   * was never there. A client that diffed against a remembered list would read
   * that as the gateway inventing a toolset.
   */
  it('hides a default-off toolset until something enables it', async () => {
    const names = async (): Promise<string[]> =>
      harness
        .call('profiles.describe', { name: 'researcher' })
        .then(frame => ((frame.result as Record<string, unknown>).toolsets as { name: string }[]).map(row => row.name))

    expect(await names()).not.toContain('kanban')

    await harness.call('profiles.configure', { name: 'researcher', enabled_toolsets: ['files', 'kanban'] })

    expect(await names()).toContain('kanban')
  })

  it('reports each MCP server with its transport and its per-bot switch', async () => {
    const servers = ((await harness.call('profiles.describe', { name: 'writer' })).result as Record<string, unknown>)
      .mcp_servers as Record<string, unknown>[]

    expect(servers.find(server => server.name === 'weather')?.enabled).toBe(false)
    expect(servers.find(server => server.name === 'files')?.enabled).toBe(true)
    expect(servers.every(server => typeof server.transport === 'string')).toBe(true)
  })

  it('refuses a profile it does not have', async () => {
    expect((await harness.call('profiles.describe', { name: 'nobody' })).error).toBeTruthy()
  })
})

/**
 * Writing the three capability sections, over the socket.
 *
 * Upstream: `methods_profiles.py::_configure_cfg_sections` and the three savers
 * beside it — `save_disabled_skills`, `_save_toolset_pin`, `_save_mcp_toggles`.
 *
 * All three are REPLACE semantics over a full list, and no two of them are the
 * same polarity. The desktop's own editor
 * (`apps/desktop/src/plugins/hermes-bots/profile-config.tsx`) builds all three
 * this way, including the `[]`-means-unpin rule, and these cases are the reason
 * a client can be written against them without a live gateway.
 */
describe('profiles.configure capabilities — methods_profiles.py::_configure_cfg_sections', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  const describeProfile = async (name: string): Promise<Record<string, unknown>> =>
    (await harness.call('profiles.describe', { name })).result as Record<string, unknown>

  it('reports each section under the name upstream uses, not the parameter name', async () => {
    const applied = (
      (
        await harness.call('profiles.configure', {
          name: 'researcher',
          disabled_skills: ['pdf'],
          enabled_toolsets: ['files'],
          enabled_mcp_servers: ['files']
        })
      ).result as Record<string, unknown>
    ).applied as Record<string, unknown>

    expect(keysOf(applied)).toEqual(['mcp_servers', 'skills', 'toolsets'])
  })

  it('takes the DISABLED list for skills and replaces it whole', async () => {
    await harness.call('profiles.configure', { name: 'writer', disabled_skills: ['docx'] })

    const skills = (await describeProfile('writer')).skills as { name: string; enabled: boolean }[]

    // `pdf` was the disabled one before this write and is on again, because the
    // list replaces rather than adds.
    expect(skills.find(skill => skill.name === 'pdf')?.enabled).toBe(true)
    expect(skills.find(skill => skill.name === 'docx')?.enabled).toBe(false)
  })

  it('clears the disabled set when the list is empty', async () => {
    await harness.call('profiles.configure', { name: 'writer', disabled_skills: [] })

    const skills = (await describeProfile('writer')).skills as { enabled: boolean }[]

    expect(skills.every(skill => skill.enabled)).toBe(true)
  })

  /**
   * `_save_toolset_pin` pops `tools.enabled_toolsets` when the list is empty, so
   * an empty list UNPINS and the platform defaults come back. Reading it as
   * "switch everything off" is the mistake that makes a bot lose its tools the
   * first time somebody turns the last switch off.
   */
  it('unpins on an empty toolset list rather than disabling everything', async () => {
    await harness.call('profiles.configure', { name: 'writer', enabled_toolsets: ['web'] })

    const pinned = await describeProfile('writer')

    expect(pinned.toolsets_pinned).toBe(true)
    expect((pinned.toolsets as { name: string; enabled: boolean }[]).find(row => row.name === 'files')?.enabled).toBe(
      false
    )

    await harness.call('profiles.configure', { name: 'writer', enabled_toolsets: [] })

    const unpinned = await describeProfile('writer')

    expect(unpinned.toolsets_pinned).toBe(false)
    expect((unpinned.toolsets as { name: string; enabled: boolean }[]).find(row => row.name === 'files')?.enabled).toBe(
      true
    )
  })

  it('takes the ENABLED list for MCP servers, which is the other polarity', async () => {
    await harness.call('profiles.configure', { name: 'researcher', enabled_mcp_servers: ['calendar'] })

    const servers = (await describeProfile('researcher')).mcp_servers as { name: string; enabled: boolean }[]

    expect(servers.find(server => server.name === 'calendar')?.enabled).toBe(true)
    expect(servers.find(server => server.name === 'files')?.enabled).toBe(false)
  })

  it('leaves a section alone when the request does not carry it', async () => {
    await harness.call('profiles.configure', { name: 'researcher', enabled_mcp_servers: ['calendar'] })

    const applied = (
      (await harness.call('profiles.configure', { name: 'researcher', description: 'Still finds things out.' }))
        .result as Record<string, unknown>
    ).applied as Record<string, unknown>

    expect(applied).not.toHaveProperty('mcp_servers')
    expect(
      ((await describeProfile('researcher')).mcp_servers as { name: string; enabled: boolean }[]).find(
        server => server.name === 'calendar'
      )?.enabled
    ).toBe(true)
  })

  /** A clone copies config.yaml, which is where all three sections live. */
  it('carries the source bot’s capability state into a clone', async () => {
    await harness.call('profiles.configure', {
      name: 'researcher',
      disabled_skills: ['web-search'],
      enabled_toolsets: ['web']
    })
    await harness.call('profiles.create', { name: 'understudy', clone_from: 'researcher' })

    const clone = await describeProfile('understudy')

    expect(clone.toolsets_pinned).toBe(true)
    expect(
      (clone.skills as { name: string; enabled: boolean }[]).find(skill => skill.name === 'web-search')?.enabled
    ).toBe(false)
  })
})

/**
 * The session-scoped toolset switch, over the socket.
 *
 * Upstream: `methods_tools.py::tools.configure` → `_configure_session_tools`.
 *
 * Worth pinning even though the desktop never calls it (it toggles toolsets over
 * REST, which a socket-only client cannot reach), because the result is the one
 * in this family that reports partial success WITHOUT an error frame: an unknown
 * toolset and an MCP target whose server is missing both come back in their own
 * arrays and are dropped from `changed`.
 */
describe('tools.configure over the socket — methods_tools.py::_configure_session_tools', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  it('answers the six keys the contract declares', async () => {
    const result = (await harness.call('tools.configure', { action: 'enable', names: ['memory'] })).result as Record<
      string,
      unknown
    >

    expect(keysOf(result)).toEqual(['changed', 'enabled_toolsets', 'info', 'missing_servers', 'reset', 'unknown'])
    expect(result.changed).toEqual(['memory'])
    expect(result.enabled_toolsets).toContain('memory')
  })

  it('reports an unknown toolset without failing the call', async () => {
    const result = (await harness.call('tools.configure', { action: 'enable', names: ['memory', 'nonsense'] }))
      .result as Record<string, unknown>

    expect(result.unknown).toEqual(['nonsense'])
    expect(result.changed).not.toContain('nonsense')
  })

  it('reports a missing MCP server separately from an unknown toolset', async () => {
    const result = (await harness.call('tools.configure', { action: 'enable', names: ['nowhere:tool'] }))
      .result as Record<string, unknown>

    expect(result.missing_servers).toEqual(['nowhere'])
    expect(result.unknown).toEqual([])
  })

  it('refuses an action that is neither enable nor disable', async () => {
    const error = (await harness.call('tools.configure', { action: 'toggle', names: ['web'] })).error as Record<
      string,
      unknown
    >

    expect(error?.code).toBe(4017)
  })

  it('refuses an empty name list', async () => {
    const error = (await harness.call('tools.configure', { action: 'enable', names: [] })).error as Record<
      string,
      unknown
    >

    expect(error?.code).toBe(4018)
  })
})

/**
 * Skills, over the socket.
 *
 * Upstream: `methods_tools.py::skills.manage` → `_run_action` over
 * `_SKILLS_ACTIONS`.
 *
 * Five actions behind one method, each answering a DIFFERENT key. `list` answers
 * a category map rather than a flat list and carries no enabled flag at all —
 * which is why the Skills page has to join it against `profiles.describe`, and
 * why a client that expected `skills` to be an array would paint nothing.
 */
describe('skills.manage over the socket — methods_tools.py::_SKILLS_ACTIONS', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  it('answers `list` as a category map of names, with no enabled flag', async () => {
    const result = (await harness.call('skills.manage', { action: 'list', profile: 'researcher' })).result as Record<
      string,
      unknown
    >
    const skills = result.skills as Record<string, string[]>

    expect(Array.isArray(skills)).toBe(false)
    expect(Object.values(skills).every(names => Array.isArray(names))).toBe(true)
    expect(Object.values(skills).flat()).toContain('pdf')
  })

  it('defaults to `list` when no action is given, like `_run_action`', async () => {
    expect((await harness.call('skills.manage', { profile: 'researcher' })).result).toHaveProperty('skills')
  })

  it('answers `search` as `results` of {name, description}', async () => {
    const results = (
      (await harness.call('skills.manage', { action: 'search', query: 'pdf' })).result as Record<string, unknown>
    ).results as Record<string, unknown>[]

    expect(results.length).toBeGreaterThan(0)
    expect(keysOf(results[0])).toEqual(['description', 'name'])
  })

  it('answers `browse` as `items` plus paging', async () => {
    const result = (await harness.call('skills.manage', { action: 'browse', page: 1, page_size: 2 })).result as Record<
      string,
      unknown
    >

    expect((result.items as unknown[]).length).toBe(2)
    expect(result.page).toBe(1)
    expect(typeof result.total_pages).toBe('number')
    expect(typeof result.total).toBe('number')
  })

  it('answers `inspect` as `info`, and an empty object for a miss', async () => {
    const hit = (
      (await harness.call('skills.manage', { action: 'inspect', query: 'pdf' })).result as Record<string, unknown>
    ).info as Record<string, unknown>

    expect(hit.name).toBe('pdf')

    const miss = (await harness.call('skills.manage', { action: 'inspect', query: 'nope' })).result as Record<
      string,
      unknown
    >

    expect(miss.info).toEqual({})
  })

  /**
   * `_skills_install` calls `do_install(skip_confirm=True)`, so installing from
   * the hub really does work over the socket. The Skills page offers the button
   * because of this case; if upstream ever made it CLI-only, this is what would
   * go red.
   */
  it('installs from the hub over the socket and answers {installed, name}', async () => {
    const result = (await harness.call('skills.manage', { action: 'install', query: 'xlsx', profile: 'researcher' }))
      .result as Record<string, unknown>

    expect(result).toEqual({ installed: true, name: 'xlsx' })

    const listed = (
      (await harness.call('skills.manage', { action: 'list', profile: 'researcher' })).result as Record<string, unknown>
    ).skills as Record<string, string[]>

    expect(Object.values(listed).flat()).toContain('xlsx')
  })

  it('refuses an action it does not have with 4017', async () => {
    const error = (await harness.call('skills.manage', { action: 'uninstall', query: 'pdf' })).error as Record<
      string,
      unknown
    >

    expect(error?.code).toBe(4017)
  })
})

/**
 * MCP servers, over the socket.
 *
 * Upstream: `methods_tools.py`, the `@_mcp_rpc` block — `list`, `status`,
 * `test`, `oauth.start`, `oauth.poll`, `oauth.cancel`.
 *
 * The one that decides the whole page's design is `test`: a failure is a
 * SUCCESSFUL RPC answering `{ok: false, error, tools: []}`, and so is the
 * needs-auth case. A client that only inspects the error frame reports a broken
 * server as working.
 */
/**
 * The connector RPCs, over the socket.
 *
 * Upstream: `tui_gateway/methods_connectors.py`, whose whole registered surface
 * is `connectors.list`, `connectors.connect`, `connectors.operation.status`,
 * `connectors.operation.wake` and `connection.respond`. Three things are worth
 * pinning and none of them is visible from a screen:
 *
 *  - every call names its scope with `owner` (`ConnectorOwner`): a chat's
 *    runtime session, whose id is only a lookup hint — authority is transport
 *    attachment — or the account. Never a top-level `session_id`, which the
 *    contract refuses although the generated TS contract still spells it so;
 *  - `available: false` is a SUCCESS that means the bot's `manage_connections`
 *    toolset is off, not an empty account;
 *  - the authorisation link rides at `targets[].connect_url` and nowhere else,
 *    surviving `connector_ui_payload` only because that key is exempted by name.
 *
 * `connectors.operation.wake` is pinned although the VENDORED contract has no
 * such method: the gateway registers it (`ConnectionOperationParams`, like
 * `status`), this repo's copy of the contract predates that, and without a
 * fixture nothing here would notice.
 */
/**
 * The Kanban plugin's router — `plugins/kanban/dashboard/plugin_api.py`.
 *
 * Kanban is a PLUGIN and all of it is REST: there is no socket method for any
 * of it, the gateway's `/kanban` slash command answers prose, and `ui_meta` is
 * a per-profile blob with no list semantics. So a client speaks the same
 * `/api/plugins/kanban/*` the desktop plugin does, and these cases pin the
 * parts of it that do not behave like a board app.
 */
describe('/api/plugins/kanban — plugin_api.py', () => {
  const call = async (
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${gateway.url}/api/plugins/kanban${path}`, {
      method: init?.method ?? 'GET',
      ...(init?.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) })
    })

    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('lists the boards on disk with their card counts', async () => {
    const { body } = await call('/boards')
    const boards = body.boards as Record<string, unknown>[]

    expect(boards.length).toBeGreaterThan(0)
    expect(keysOf(boards[0])).toEqual(['description', 'is_current', 'name', 'slug', 'total'])
  })

  /**
   * Columns are a server-owned CONSTANT and a card's column is its `status`.
   * There is no column id, no create-column and no reorder-column anywhere in
   * the router.
   */
  it('answers the fixed column list, in plugin_api’s own order', async () => {
    const { body } = await call('/board?board=default')
    const names = (body.columns as Record<string, unknown>[]).map(column => column.name)

    expect(names).toEqual(['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'])
  })

  /** `archived` is a filter toggle rather than a column, and only on request. */
  it('appends archived only when it was asked for', async () => {
    const { body } = await call('/board?board=default&include_archived=true')
    const names = (body.columns as Record<string, unknown>[]).map(column => column.name)

    expect(names[names.length - 1]).toBe('archived')
  })

  /**
   * There is no `position`, `index` or rank on a card — the server sorts by
   * `priority DESC, created_at ASC`, which is why the app says there is no
   * order to drag within a column.
   */
  it('sorts a column by priority and then age, and carries no position at all', async () => {
    const { body } = await call('/board?board=default')
    const todo = (body.columns as Record<string, unknown>[]).find(column => column.name === 'todo')
    const cards = todo?.tasks as Record<string, unknown>[]

    expect(cards.map(card => card.title)).toEqual(['Ship the build', 'Write the release notes'])
    expect(cards[0]).not.toHaveProperty('position')
    expect(cards[0]).not.toHaveProperty('index')
  })

  /**
   * `POST /tasks` has no `status` field at all. The server derives `triage` or
   * `ready`, so a client that sent a status would have it ignored and the card
   * would land in `ready`.
   */
  it('derives a new card’s column rather than taking one', async () => {
    const ready = await call('/tasks?board=sprint', { method: 'POST', body: { title: 'a', status: 'done' } })
    const triaged = await call('/tasks?board=sprint', { method: 'POST', body: { title: 'b', triage: true } })

    expect((ready.body.task as Record<string, unknown>).status).toBe('ready')
    expect((triaged.body.task as Record<string, unknown>).status).toBe('triage')
  })

  it('moves a card with a status and nothing else', async () => {
    const { body } = await call('/tasks/t_aa11bb22?board=default', { method: 'PATCH', body: { status: 'done' } })

    expect((body.task as Record<string, unknown>).status).toBe('done')
  })

  /** `_apply_status` raises for this one before it looks at anything else. */
  it('refuses running outright, with the message upstream wrote', async () => {
    const { status, body } = await call('/tasks/t_ee55ff66?board=default', {
      method: 'PATCH',
      body: { status: 'running' }
    })

    expect(status).toBe(400)
    expect(String(body.detail)).toMatch(/Cannot set status to 'running' directly/u)
  })

  /**
   * The refusal whose sentence a client cannot reconstruct: it NAMES the
   * parent cards that are blocking, which is why the app shows `detail`
   * verbatim rather than writing its own "could not move the card".
   */
  it('refuses a ready whose parents are not done, and names them', async () => {
    // Its own gateway: the parent this case needs still open is a card another
    // case in this file moves to `done`, and a suite whose outcome depends on
    // which order it ran in is not pinning anything.
    const live = await startFakeGateway({ port: 0 })

    try {
      const response = await fetch(`${live.url}/api/plugins/kanban/tasks/t_cc33dd44?board=default`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ready' })
      })
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(409)
      expect(String(body.detail)).toContain('blocked by parent(s) not done')
      expect(String(body.detail)).toContain('t_aa11bb22')
    } finally {
      await live.close()
    }
  })

  it('takes an archive as a status, which is recoverable', async () => {
    const { body } = await call('/tasks/t_ee55ff66?board=default', { method: 'PATCH', body: { status: 'archived' } })

    expect((body.task as Record<string, unknown>).status).toBe('archived')
  })

  /**
   * The comment route answers `{ok: true}` and NOT the comment it made, so a
   * client has to re-read the task to see it. `author` defaults to
   * `"dashboard"`, which is why a client that is not the dashboard sends one.
   */
  it('takes a comment, answers ok, and hands it back only on the task', async () => {
    const posted = await call('/tasks/t_aa11bb22/comments?board=default', {
      method: 'POST',
      body: { author: 'hermie', body: 'on it' }
    })

    expect(posted.body).toEqual({ ok: true })

    const { body } = await call('/tasks/t_aa11bb22?board=default')
    const comments = body.comments as Record<string, unknown>[]

    expect(comments[comments.length - 1]).toMatchObject({ author: 'hermie', body: 'on it' })
    expect(keysOf(comments[0])).toEqual(['author', 'body', 'created_at', 'id'])
  })

  it('answers a 404 WITH a detail for one card it does not have', async () => {
    const { status, body } = await call('/tasks/t_nope?board=default')

    expect(status).toBe(404)
    expect(body.detail).toBe('task not found')
  })

  /**
   * And the other 404: the PREFIX. `web_server_dashboard.py` mounts the router
   * only for a plugin that is bundled or enabled, so a gateway without it has
   * nothing to answer with — which is why the app offers an install command
   * rather than an empty board.
   */
  it('404s the whole prefix, with no detail, when the plugin is not mounted', async () => {
    const live = await startFakeGateway({ port: 0 })

    try {
      live.state.kanbanBoards = null

      const response = await fetch(`${live.url}/api/plugins/kanban/boards`)

      expect(response.status).toBe(404)
    } finally {
      await live.close()
    }
  })

  it('counts a dispatch nudge, which is what keeps a new card off the 60s tick', async () => {
    const before = gateway.state.kanbanDispatches

    await call('/dispatch?board=default', { method: 'POST', body: {} })

    expect(gateway.state.kanbanDispatches).toBe(before + 1)
  })
})

describe('connectors.* over the socket — methods_connectors.py', () => {
  const harness = socketHarness()
  /** `SessionOwner` (`tui_gateway/contracts/common.py`): how every call names the chat it is about. */
  const OWNER = { type: 'session', session_id: 'sess-1' }

  beforeAll(harness.open)
  afterAll(harness.close)

  const errorOf = (frame: Record<string, unknown>) => frame.error as { code?: number; data?: { reason?: string } }

  it('refuses a call that names no owner, because the owner is how it is scoped', async () => {
    const frame = await harness.call('connectors.list')

    expect(errorOf(frame)?.code).toBe(4000)
    expect(errorOf(frame)?.data?.reason).toBe('INVALID_PARAMS')
  })

  /**
   * HERM-188. Every params model is `extra="forbid"`, and the generated TS
   * contract still spells the session as a top-level `session_id`: the gateway
   * refuses that spelling, so the fake does too, on every connector method.
   */
  it.each([
    ['connectors.list', {}],
    ['connectors.connect', { connectors: ['gmail'] }],
    ['connectors.operation.status', { op_id: 'op-1' }],
    ['connectors.operation.wake', { op_id: 'op-1' }]
  ])('%s refuses the generated contract’s top-level session_id and any unknown key', async (method, rest) => {
    for (const params of [
      { session_id: 'sess-1', ...rest },
      { owner: OWNER, session_id: 'sess-1', ...rest },
      { owner: OWNER, surprise: true, ...rest },
      { owner: { ...OWNER, extra: 1 }, ...rest },
      { owner: { type: 'session' }, ...rest },
      { owner: { type: 'session', session_id: '' }, ...rest },
      { owner: { type: 'account', session_id: 'sess-1' }, ...rest },
      { owner: { type: 'team' }, ...rest },
      { owner: OWNER, profile: 7, ...rest }
    ]) {
      const frame = await harness.call(method, params)

      expect(errorOf(frame)?.code, `${method} ${JSON.stringify(params)}`).toBe(4000)
      expect(errorOf(frame)?.data?.reason).toBe('INVALID_PARAMS')
    }
  })

  it('takes exactly the contract’s keys, profile included', async () => {
    const listed = await harness.call('connectors.list', { profile: 'researcher', owner: OWNER })
    const opened = await harness.call('connectors.connect', {
      profile: null,
      owner: OWNER,
      connectors: ['gmail'],
      reconnect: false
    })
    const opId = (opened.result as Record<string, unknown>).op_id
    const status = await harness.call('connectors.operation.status', {
      profile: 'researcher',
      owner: OWNER,
      op_id: opId
    })
    const wake = await harness.call('connectors.operation.wake', { profile: 'researcher', owner: OWNER, op_id: opId })

    expect([listed.error, opened.error, status.error, wake.error]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('refuses a reconnect that is not a boolean', async () => {
    const frame = await harness.call('connectors.connect', { owner: OWNER, connectors: ['gmail'], reconnect: 'yes' })

    expect(errorOf(frame)?.code).toBe(4000)
  })

  /** `live.get(session_key, op_id)`: an operation answers only to the owner that holds it. */
  it('keeps one owner’s operation out of another’s reach', async () => {
    const opened = (await harness.call('connectors.connect', { owner: OWNER, connectors: ['gmail'] })).result as Record<
      string,
      unknown
    >
    const elsewhere = await harness.call('connectors.operation.status', {
      owner: { type: 'session', session_id: 'sess-other' },
      op_id: opened.op_id
    })
    const account = await harness.call('connectors.operation.wake', { owner: { type: 'account' }, op_id: opened.op_id })

    expect(errorOf(elsewhere)?.code).toBe(4004)
    expect(errorOf(elsewhere)?.data?.reason).toBe('UNKNOWN_OPERATION')
    expect(errorOf(account)?.code).toBe(4004)
  })

  it('opens an account-wide operation for the account owner, which a session cannot reach', async () => {
    const listed = await harness.call('connectors.list', { owner: { type: 'account' } })
    const opened = (await harness.call('connectors.connect', { owner: { type: 'account' }, connectors: ['notion'] }))
      .result as Record<string, unknown>
    const status = await harness.call('connectors.operation.status', {
      owner: { type: 'account' },
      op_id: opened.op_id
    })
    const fromChat = await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id })

    expect((listed.result as Record<string, unknown>).available).toBe(true)
    expect(status.error).toBeUndefined()
    expect(errorOf(fromChat)?.code).toBe(4004)
  })

  it('lists the catalogue with the vendor key set, statusReason included', async () => {
    const result = (await harness.call('connectors.list', { owner: OWNER })).result as Record<string, unknown>
    const rows = result.connectors as Record<string, unknown>[]

    expect(result.available).toBe(true)
    expect(keysOf(rows[0])).toEqual(['connected', 'connectionStatus', 'connector', 'enabled', 'statusReason'])
    expect(rows.find(row => row.connector === 'slack')?.statusReason).toBe('the workspace revoked the token')
  })

  /**
   * The answer a client most easily misreads. Nothing in the frame says
   * "error", so a page that drew `connectors.length === 0` as "you have none"
   * would report an empty account for a switch the reader can turn on.
   */
  it('answers available:false — a SUCCESS — when the toolset is off', async () => {
    harness.state().connectorsUnavailable = true

    try {
      const frame = await harness.call('connectors.list', { owner: OWNER })

      expect(frame.error).toBeUndefined()
      expect(frame.result).toEqual({ available: false, connectors: [] })

      // And the connect half refuses OUTRIGHT in the same state, which is the
      // asymmetry: `list` degrades, `connect` raises `CONNECTORS_UNAVAILABLE`.
      const refused = await harness.call('connectors.connect', { owner: OWNER, connectors: ['gmail'] })

      expect((refused.error as Record<string, unknown>)?.code).toBe(4031)
    } finally {
      harness.state().connectorsUnavailable = false
    }
  })

  it('mints an operation whose link lives on the target, not at the top level', async () => {
    const result = (await harness.call('connectors.connect', { owner: OWNER, connectors: ['notion'] }))
      .result as Record<string, unknown>

    expect(typeof result.op_id).toBe('string')
    expect(typeof result.seq).toBe('number')
    expect(result.connect_url).toBeUndefined()

    const targets = result.targets as Record<string, unknown>[]

    expect(keysOf(targets[0])).toEqual(['action', 'connect_url', 'detail', 'kind', 'name', 'state'])
    expect(targets[0]?.state).toBe('initiated')
    expect(String(targets[0]?.connect_url)).toMatch(/^https:\/\//u)
  })

  it('refuses a slug the catalogue does not carry', async () => {
    const frame = await harness.call('connectors.connect', { owner: OWNER, connectors: ['nope'] })

    expect((frame.error as Record<string, unknown>)?.code).toBe(4004)
  })

  it('refuses an empty or malformed slug list', async () => {
    const empty = await harness.call('connectors.connect', { owner: OWNER, connectors: [] })
    const bad = await harness.call('connectors.connect', { owner: OWNER, connectors: ['Not A Slug'] })

    expect((empty.error as Record<string, unknown>)?.code).toBe(4000)
    expect((bad.error as Record<string, unknown>)?.code).toBe(4000)
  })

  /**
   * `seq` is the ordering guard the vendored contract is missing. The gateway's
   * own account watcher moves a target on its own tick while a client polls, so
   * without it a client cannot tell a newer snapshot from an older one.
   */
  it('stamps every snapshot with a seq that only ever goes up', async () => {
    const opened = (await harness.call('connectors.connect', { owner: OWNER, connectors: ['gmail'] })).result as Record<
      string,
      unknown
    >
    const first = (await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id }))
      .result as Record<string, unknown>
    const second = (await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id }))
      .result as Record<string, unknown>

    expect(Number(first.seq)).toBeGreaterThan(Number(opened.seq))
    expect(Number(second.seq)).toBeGreaterThan(Number(first.seq))
  })

  it('settles the operation once every target has stopped moving', async () => {
    const opened = (await harness.call('connectors.connect', { owner: OWNER, connectors: ['gmail'] })).result as Record<
      string,
      unknown
    >

    await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id })

    const settled = (await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id }))
      .result as Record<string, unknown>

    expect(settled.settled).toBe(true)
    expect(settled.settled_by).toBe('all_resolved')
    expect((settled.targets as Record<string, unknown>[])[0]?.state).toBe('connected')
  })

  it('reports a refused grant as a settled FAILED target, never as an error frame', async () => {
    const opened = (await harness.call('connectors.connect', { owner: OWNER, connectors: ['slack'] })).result as Record<
      string,
      unknown
    >

    await harness.call('connectors.operation.wake', { owner: OWNER, op_id: opened.op_id })

    const frame = await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id })
    const target = ((frame.result as Record<string, unknown>).targets as Record<string, unknown>[])[0]

    expect(frame.error).toBeUndefined()
    expect(target?.state).toBe('failed')
    expect(target?.detail).toBe('the workspace refused the grant')
  })

  /** The method the vendored contract has not grown. It only shortens the wait. */
  it('wakes an operation so the account is read now rather than on the next tick', async () => {
    const opened = (await harness.call('connectors.connect', { owner: OWNER, connectors: ['notion'] }))
      .result as Record<string, unknown>

    expect((await harness.call('connectors.operation.wake', { owner: OWNER, op_id: opened.op_id })).result).toEqual({
      status: 'ok'
    })

    const woken = (await harness.call('connectors.operation.status', { owner: OWNER, op_id: opened.op_id }))
      .result as Record<string, unknown>

    // One read, where an unwoken operation needs two.
    expect((woken.targets as Record<string, unknown>[])[0]?.state).toBe('connected')
  })

  it('refuses an op_id it does not hold', async () => {
    const frame = await harness.call('connectors.operation.status', { owner: OWNER, op_id: 'op-nope' })

    expect((frame.error as Record<string, unknown>)?.code).toBe(4004)
  })
})

describe('mcp.servers.* over the socket — methods_tools.py::_mcp_rpc', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  it('lists servers with env KEY NAMES and never their values', async () => {
    const servers = ((await harness.call('mcp.servers.list')).result as Record<string, unknown>).servers as Record<
      string,
      unknown
    >[]

    expect(servers.length).toBeGreaterThan(0)
    expect(keysOf(servers[0])).toEqual([
      'args',
      'auth',
      'command',
      'enabled',
      'env',
      'name',
      'oauth_tokens_present',
      'tools',
      'transport',
      'url'
    ])
    expect(servers.find(server => server.name === 'weather')?.env).toEqual(['WEATHER_API_KEY'])
  })

  /**
   * `status` reads CACHED runtime state and never connects, probes or starts
   * auth — upstream says so in the docstring. So the OAuth server looks healthy
   * here, and only `test` can tell the difference. Anything that draws a
   * "needs auth" badge has to probe for it.
   */
  it('answers a cheap runtime view whose status vocabulary is the runtime one', async () => {
    const result = (await harness.call('mcp.servers.status')).result as Record<string, unknown>
    const servers = result.servers as Record<string, unknown>[]

    expect(typeof result.checked_at).toBe('number')
    expect(keysOf(servers[0])).toEqual(['connected', 'disabled', 'name', 'status', 'tools', 'transport'])

    for (const server of servers) {
      expect(['connected', 'disabled', 'connecting', 'failed', 'lazy', 'configured']).toContain(server.status)
    }

    expect(servers.find(server => server.name === 'calendar')?.status).toBe('connected')
  })

  it('answers a good probe with ok and the tool list', async () => {
    const result = (await harness.call('mcp.servers.test', { name: 'files' })).result as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect((result.tools as Record<string, unknown>[])[0]).toHaveProperty('description')
    expect(result.oauth_needed).toBe(false)
  })

  it('answers a failing probe with ok:false and no error frame at all', async () => {
    const frame = await harness.call('mcp.servers.test', { name: 'weather' })
    const result = frame.result as Record<string, unknown>

    expect(frame.error).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(result.tools).toEqual([])
    expect(typeof result.error).toBe('string')
  })

  /**
   * The false-green upstream comments on: an `auth: oauth` server whose
   * `tools/list` would answer anonymously is still `ok: false` while no token is
   * on disk, because a green probe with no token is not a working server.
   */
  it('refuses to call an OAuth server healthy while it has no token', async () => {
    const result = (await harness.call('mcp.servers.test', { name: 'calendar' })).result as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(result.oauth_needed).toBe(true)
    expect(result.oauth_tokens_present).toBe(false)
  })

  it('walks a PKCE flow from start to approved, and the probe goes green after it', async () => {
    const started = (await harness.call('mcp.servers.oauth.start', { name: 'calendar' })).result as Record<
      string,
      unknown
    >

    expect(keysOf(started)).toEqual(['auth_url', 'flow', 'ok', 'session_id'])
    expect(started.flow).toBe('pkce')
    expect(String(started.auth_url)).toMatch(/^https:\/\//)

    const flowId = String(started.session_id)
    const pending = (await harness.call('mcp.servers.oauth.poll', { name: 'calendar', session_id: flowId }))
      .result as Record<string, unknown>

    expect(pending.status).toBe('pending')

    const approved = (await harness.call('mcp.servers.oauth.poll', { name: 'calendar', session_id: flowId }))
      .result as Record<string, unknown>

    expect(approved.status).toBe('approved')
    expect((await harness.call('mcp.servers.test', { name: 'calendar' })).result).toMatchObject({ ok: true })
  })

  it('refuses OAuth on a stdio server, which authenticates with env keys', async () => {
    const error = (await harness.call('mcp.servers.oauth.start', { name: 'files' })).error as Record<string, unknown>

    expect(error?.code).toBe(4001)
    expect(String(error?.message)).toContain('stdio')
  })
})

/**
 * `reload.mcp`, over the socket.
 *
 * Upstream: `methods_tools.py::reload.mcp` for the gate, and
 * `tui_gateway/server.py::_finish_reload` for where `always` is stored.
 *
 * The only call in this round that REFUSES BY SUCCEEDING. Without `confirm` it
 * answers a 200 carrying `status: 'confirm_required'` and a message, so a client
 * that checks only the error frame believes it reloaded. The desktop sidesteps
 * this entirely by always sending `confirm: true`; Hermie shows the sheet, which
 * is why the fake models the gate rather than the shortcut.
 */
describe('reload.mcp over the socket — methods_tools.py::reload.mcp', () => {
  const harness = socketHarness()

  beforeAll(harness.open)
  afterAll(harness.close)

  it('asks first, with a 200 and no error frame', async () => {
    const frame = await harness.call('reload.mcp', {})
    const result = frame.result as Record<string, unknown>

    expect(frame.error).toBeUndefined()
    expect(result.status).toBe('confirm_required')
    expect(String(result.message)).toContain('prompt cache')
  })

  it('goes through on confirm, and asks again next time', async () => {
    expect(((await harness.call('reload.mcp', { confirm: true })).result as Record<string, unknown>).status).toBe(
      'reloaded'
    )
    expect(((await harness.call('reload.mcp', {})).result as Record<string, unknown>).status).toBe('confirm_required')
  })

  /**
   * `always` proceeds AND clears `approvals.mcp_reload_confirm` — in the
   * GATEWAY's config, not the client's. So the opt-out is shared with the CLI
   * and the desktop, and a client that stored it locally would keep asking on a
   * gateway that had already been told not to.
   */
  it('stops asking for good once `always` has been sent', async () => {
    expect(((await harness.call('reload.mcp', { always: true })).result as Record<string, unknown>).status).toBe(
      'reloaded'
    )
    expect(((await harness.call('reload.mcp', {})).result as Record<string, unknown>).status).toBe('reloaded')
  })
})

/**
 * What a client may rely on to tell which stored row a live frame becomes.
 *
 * Upstream: our fork's `tests/tui_gateway/test_transcript_row_identity_e2e.py` (branch
 * `wip/row-identity`), which runs one real turn through `prompt.submit` and reads the frames, the
 * replay ring, `session.resume` and `session.history` back the way a client does. The expectations
 * below are that test's, written as literals, so the fake and the fork cannot drift apart without
 * one of the two failing:
 *
 *  - a turn has ONE `turn_id`: on the envelope of every frame it streams and on its user row's
 *    `display_metadata`; frames that are not part of the turn's stream carry none;
 *  - `message.interim` and `message.complete` name their assistant row (`row_id`);
 *  - `tool.start` names its call as `(call_row_id, call_index)` and carries NO `row_id`;
 *    `tool.complete` names the call and the tool RESULT row (`row_id`); history tool rows carry the
 *    same three numbers, and `tool_call_id` is the id `tool.start` sent as `tool_id`;
 *  - the replay ring returns the same frames, ids included;
 *  - a `session.resume` mid-turn says which streamed text no sealed note shows yet.
 *
 * With `rowIdentity: false` it is the gateway before any of that: no ids, no `message.interim`.
 */
describe('transcript row identity — test_transcript_row_identity_e2e.py', () => {
  const NOTE_1 = 'Entry 90 is marked paid. Now the cent on the payables account: first see how it is booked.'
  const NOTE_2 = 'Looking the transfer up through the API myself: the payout of 16-09.'
  const FINAL = 'Everything checks out and nothing was filed.'
  const TURN_STREAM = [
    'message.start',
    'message.delta',
    'message.interim',
    'message.complete',
    'reasoning.delta',
    'reasoning.available',
    'thinking.delta',
    'tool.generating',
    'tool.start',
    'tool.complete',
    'tool.output_risk',
    'error'
  ]

  type Params = Record<string, unknown> & { type: string; turn_id?: string; payload?: Record<string, unknown> }
  type Row = Record<string, unknown>

  interface Rig {
    live: FakeGateway
    events: Params[]
    call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
    runtime: string
    stored: string
    until: (check: () => boolean) => Promise<void>
    finish: () => Promise<void>
    history: () => Promise<Row[]>
    close: () => void
  }

  let rig: Rig | undefined

  const open = async (options: { rowIdentity?: boolean; streamDelayMs?: number } = {}): Promise<Rig> => {
    const live = await startFakeGateway({ port: 0, ...options })
    const socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    const events: Params[] = []
    let nextId = 0

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>

        if (frame.method === 'event') {
          events.push(frame.params as Params)
        } else if (typeof frame.id === 'number') {
          pending.get(frame.id)?.(frame)
          pending.delete(frame.id)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>(resolve => {
        const id = ++nextId

        pending.set(id, resolve)
        socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })

    const listed = await call('profiles.list', { include_sessions: true })
    const roster = (listed.result as { profiles: { name: string; canonical_session?: { id: string } }[] }).profiles
    const stored = roster.find(profile => profile.name === 'researcher')?.canonical_session?.id ?? ''
    const resumed = await call('session.resume', { session_id: stored, omit_messages: true })
    const runtime = String((resumed.result as { session_id: string }).session_id)

    const until = async (check: () => boolean): Promise<void> => {
      for (let waited = 0; waited < 5000; waited += 5) {
        if (check()) {
          return
        }

        await new Promise(resolve => setTimeout(resolve, 5))
      }

      throw new Error('timed out waiting for the gateway')
    }

    // The turn is over once its completion has been followed by the roster nudge.
    const finish = () =>
      until(() => {
        const at = events.findLastIndex(event => event.type === 'message.complete')

        return at >= 0 && events.slice(at).some(event => event.type === 'sessions.changed')
      })

    const history = async (): Promise<Row[]> =>
      ((await call('session.history', { session_id: runtime })).result as { messages: Row[] }).messages

    rig = { live, events, call, runtime, stored, until, finish, history, close: () => socket.close() }

    return rig
  }

  afterEach(async () => {
    const current = rig

    rig = undefined
    current?.close()
    await current?.live.close()
  })

  const submit = async (via: Rig, text: string): Promise<void> => {
    expect(((await via.call('prompt.submit', { session_id: via.runtime, text })).result as Row).status).toBe(
      'streaming'
    )
  }

  const of = (events: Params[], ...types: string[]): Params[] => events.filter(event => types.includes(event.type))
  const payloads = (events: Params[], type: string): Row[] => of(events, type).map(event => event.payload ?? {})
  const keys = (value: unknown): string[] => Object.keys(value as Row).sort()
  /** The turn's own rows: from its user row on. */
  const turnRows = (rows: Row[]): Row[] => rows.slice(rows.findLastIndex(row => row.role === 'user'))
  const resumeOf = async (via: Rig): Promise<Row> =>
    (await via.call('session.resume', { session_id: via.stored, omit_messages: true })).result as Row

  it('names the turn on every frame and on the user row, the rows on the frames that persist them, and the calls on the tools', async () => {
    const via = await open()

    await submit(via, 'check the ledger')
    await via.finish()

    const rows = turnRows(await via.history())
    const [user, note1, tool1, note2, tool2, final] = rows as [Row, Row, Row, Row, Row, Row]

    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])

    // One turn, one id: the user row and every frame of the turn name it.
    const turnId = (user.display_metadata as { turn_id: string }).turn_id

    expect(turnId).toMatch(/^[0-9a-f]{32}$/)

    const frames = via.events.filter(event => event.session_id === via.runtime)
    const stream = frames.filter(event => TURN_STREAM.includes(event.type))

    expect(new Set(stream.map(event => event.type))).toEqual(
      new Set(['message.start', 'message.delta', 'message.interim', 'tool.start', 'tool.complete', 'message.complete'])
    )
    expect(new Set(stream.map(event => event.turn_id))).toEqual(new Set([turnId]))
    // What is not part of the turn's stream carries no turn.
    expect(via.events.filter(event => !TURN_STREAM.includes(event.type) && 'turn_id' in event)).toEqual([])

    // message.interim names the assistant row that holds the note, with the same text.
    expect(payloads(frames, 'message.interim')).toEqual([
      { text: NOTE_1, already_streamed: true, row_id: note1.row_id },
      { text: NOTE_2, already_streamed: true, row_id: note2.row_id }
    ])
    expect([note1.text, note2.text]).toEqual([NOTE_1, NOTE_2])

    // tool.start names the assistant row that listed the call (the interim's row), position 0, and no row of its own.
    const starts = payloads(frames, 'tool.start')
    const completes = payloads(frames, 'tool.complete')

    expect(starts.map(start => [start.call_row_id, start.call_index])).toEqual([
      [note1.row_id, 0],
      [note2.row_id, 0]
    ])
    expect(starts.every(start => !('row_id' in start))).toBe(true)
    expect(keys(starts[0])).toEqual(['args', 'call_index', 'call_row_id', 'context', 'name', 'tool_id'])

    // tool.complete names its call and the tool RESULT row; the history tool row carries the same three numbers.
    expect(keys(completes[0])).toEqual([
      'args',
      'call_index',
      'call_row_id',
      'duration_s',
      'name',
      'result',
      'row_id',
      'summary',
      'tool_id'
    ])
    expect(completes.map(done => [done.call_row_id, done.call_index, done.row_id])).toEqual([
      [note1.row_id, 0, tool1.row_id],
      [note2.row_id, 0, tool2.row_id]
    ])

    for (const [index, tool] of [tool1, tool2].entries()) {
      expect([tool.row_id, tool.call_row_id, tool.call_index]).toEqual([
        completes[index]?.row_id,
        completes[index]?.call_row_id,
        completes[index]?.call_index
      ])
      expect(tool.tool_call_id).toBe(starts[index]?.tool_id)
      expect(tool.tool_call_id).toBe(completes[index]?.tool_id)
    }

    // message.complete names the last assistant row, the one carrying the final answer.
    const [complete] = payloads(frames, 'message.complete')

    expect(final.text).toBe(FINAL)
    expect(complete).toMatchObject({ text: FINAL, status: 'ok', row_id: final.row_id })
    expect(keys(complete)).toEqual(['persisted_turn', 'row_id', 'status', 'text', 'usage'])
    expect(complete?.persisted_turn).toEqual({
      row_ids: rows.map(row => row.row_id),
      complete: true,
      user_row_id: user.row_id,
      final_assistant_row_id: final.row_id
    })

    // The replay ring hands a reconnecting client the same frames, ids included.
    const replay = (await via.call('session.events.since', { session_id: via.runtime, last_seen: 0 })).result as {
      events: Params[]
      truncated: boolean
    }

    expect(replay.truncated).toBe(false)
    expect(replay.events).toEqual(frames.filter(event => typeof event.seq === 'number'))
    expect(of(replay.events, 'message.start').map(event => event.turn_id)).toEqual([turnId])
    expect(of(replay.events, 'message.interim', 'message.complete').map(event => event.payload?.row_id)).toEqual([
      note1.row_id,
      note2.row_id,
      final.row_id
    ])
  })

  it('carries the same identity on the REST route, which names a row `id`', async () => {
    const via = await open()

    await submit(via, 'check the ledger')
    await via.finish()

    const body = (await fetch(`${via.live.url}/api/sessions/${via.stored}/messages?order=latest&limit=50`).then(
      response => response.json()
    )) as { messages: Row[] }
    const rows = turnRows(body.messages.slice().sort((a, b) => Number(a.id) - Number(b.id)))
    const history = turnRows(await via.history())
    const tools = rows.filter(row => row.role === 'tool')

    expect((rows[0]?.display_metadata as Row).turn_id).toBe((history[0]?.display_metadata as Row).turn_id)
    expect(tools.map(row => [row.id, row.call_row_id, row.call_index, row.tool_call_id])).toEqual(
      history
        .filter(row => row.role === 'tool')
        .map(row => [row.row_id, row.call_row_id, row.call_index, row.tool_call_id])
    )
    expect(tools.every(row => typeof row.call_row_id === 'number' && row.call_index === 0)).toBe(true)
  })

  it('lets a tool reply whose words all came first persist them as the row that holds the call, and name no second row', async () => {
    const via = await open()

    await submit(via, 'whatever you like')
    await via.finish()

    const rows = turnRows(await via.history())
    const [user, call, tool] = rows as [Row, Row, Row]
    const frames = via.events.filter(event => event.session_id === via.runtime)
    const [start] = payloads(frames, 'tool.start')
    const [done] = payloads(frames, 'tool.complete')
    const [complete] = payloads(frames, 'message.complete')

    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'tool'])
    // No `message.interim`: this is a turn with interim notes off, and the call still names the assistant row.
    expect(of(frames, 'message.interim')).toEqual([])
    expect([start?.call_row_id, start?.call_index]).toEqual([call.row_id, 0])
    expect(start && 'row_id' in start).toBe(false)
    expect([done?.call_row_id, done?.call_index, done?.row_id]).toEqual([call.row_id, 0, tool.row_id])
    expect([tool.call_row_id, tool.call_index, tool.tool_call_id]).toEqual([call.row_id, 0, start?.tool_id])
    // Every word came before the call, so the row that holds the call is the answer.
    expect(call.text).toBe(complete?.text)
    expect(complete?.row_id).toBe(call.row_id)
    expect(new Set(of(frames, 'message.start', 'message.complete').map(event => event.turn_id))).toEqual(
      new Set([(user.display_metadata as { turn_id: string }).turn_id])
    )
  })

  it('says, mid-turn, which streamed text no sealed note shows yet, and which turn the prompt is', async () => {
    const via = await open({ streamDelayMs: 40 })

    await submit(via, 'check the ledger')
    await via.until(() => of(via.events, 'message.interim').length === 1)

    const turnId = of(via.events, 'message.start')[0]?.turn_id

    // `assistant` (what upstream's desktop reads) keeps the sealed note; `assistant_unsealed` leaves it out.
    expect((await resumeOf(via)).inflight).toEqual({
      assistant: NOTE_1,
      assistant_unsealed: '',
      streaming: true,
      user: 'check the ledger',
      display_metadata: { turn_id: turnId }
    })

    await via.until(() => of(via.events, 'message.interim').length === 2)

    const second = (await resumeOf(via)).inflight as Row

    expect(second.assistant).toBe(`${NOTE_1}${NOTE_2}`)
    expect(second.assistant_unsealed).toBe('')

    // Once the turn is over nothing is in flight.
    await via.finish()
    expect((await resumeOf(via)).inflight).toBeUndefined()
  })

  it('advertises it', async () => {
    const via = await open()

    expect((await via.call('gateway.capabilities')).result).toEqual({
      per_session_exclusive_submit: true,
      transcript_row_identity: true
    })
  })

  describe('with rowIdentity off: the gateway as it was before', () => {
    it('sends no identity on any frame, row or capability, and no message.interim', async () => {
      const via = await open({ rowIdentity: false })

      await submit(via, 'check the ledger')
      await via.finish()

      const rows = turnRows(await via.history())
      const frames = via.events.filter(event => event.session_id === via.runtime)
      const [user, , tool] = rows as [Row, Row, Row]

      expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
      expect(frames.filter(event => 'turn_id' in event)).toEqual([])
      expect(of(frames, 'message.interim')).toEqual([])
      expect(user.display_metadata).toBeUndefined()
      expect(keys(payloads(frames, 'tool.start')[0])).toEqual(['args', 'context', 'name', 'tool_id'])
      expect(keys(payloads(frames, 'tool.complete')[0])).toEqual([
        'args',
        'duration_s',
        'name',
        'result',
        'summary',
        'tool_id'
      ])
      expect(keys(payloads(frames, 'message.complete')[0])).toEqual(['status', 'text', 'usage'])
      // The tool row is named by its call id alone, as `session_history.py` projected it.
      expect(typeof tool.tool_call_id).toBe('string')
      expect(['row_id', 'call_row_id', 'call_index'].filter(key => key in tool)).toEqual([])
      expect((await via.call('gateway.capabilities')).result).toEqual({ per_session_exclusive_submit: true })
    })

    it('resumes mid-turn with the streamed text alone', async () => {
      const via = await open({ rowIdentity: false, streamDelayMs: 40 })

      await submit(via, 'check the ledger')
      await via.until(() => of(via.events, 'message.delta').length === 1)

      expect((await resumeOf(via)).inflight).toEqual({ assistant: NOTE_1, streaming: true, user: 'check the ledger' })

      await via.finish()
    })
  })
})
