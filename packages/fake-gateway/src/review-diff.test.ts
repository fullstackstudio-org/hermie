/**
 * `review.diff` on the fake gateway (`contract/requests/README.md` §7), over a real WebSocket.
 *
 * The control call raises it from the agent's own unified diff, which the gateway's parser reads: the hunks, their
 * ids and anchors, `kind`, `path` and `old_path` are the parser's, and a diff it refuses is a 400 with the
 * sentence the agent would get and nothing sent. The person's answer is one decision per hunk; the agent gets each
 * hunk's decision and, for an approval, `approved_patch`, composed from the gateway's own copy of the hunks.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { composePatch, parseDiff } from './diff-hunks'
import { matchesParams } from './interactive'
import {
  closeAll,
  connect,
  post,
  startPasskeyGateway,
  until,
  type Frame,
  type Harness,
  type Json
} from './passkey/harness'
import { startFakeGateway } from './server'

afterEach(closeAll)

const gateways: Harness[] = []

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

/** A gateway that does not know the passkey level: the permissive confirm and the interactive requests. */
const start = async (): Promise<Harness> => {
  const gateway = await startFakeGateway({ port: 0 })
  const harness: Harness = { gateway, url: gateway.url, close: () => gateway.close() }

  gateways.push(harness)

  return harness
}

const advertise = async (client: Awaited<ReturnType<typeof connect>>): Promise<void> => {
  await client.call('client.capabilities', { server_requests: true })
  await client.call('client.capabilities', {
    server_requests: true,
    confirm: ['plain'],
    requests: ['input.form', 'input.file', 'review.draft', 'review.diff']
  })
}

const raise = (harness: Harness, params: Json): Promise<Response> =>
  post(`${harness.url}/__fake/request`, { method: 'review.diff', params })

const view = async (harness: Harness, id: string): Promise<Json> =>
  (await (await fetch(`${harness.url}/__fake/request/${id}`)).json()) as Json

const SETTINGS = [
  '--- a/app/settings.py',
  '+++ b/app/settings.py',
  '@@ -3,4 +3,4 @@ class Settings:',
  '     name = "booking"',
  '-    currency = "USD"',
  '+    currency = "EUR"',
  '     locale = "nl-NL"',
  '     debug = False',
  '@@ -20,3 +20,4 @@ def retry():',
  '     attempts = 0',
  '-    limit = 3',
  '+    limit = 5',
  '+    backoff = 2',
  '     return attempts',
  ''
].join('\n')

const THREE = [
  '--- a/f.py',
  '+++ b/f.py',
  '@@ -3,2 +3,4 @@',
  ' a',
  '+b',
  '+c',
  ' d',
  '@@ -20,3 +22,3 @@ def f():',
  ' m',
  '-x',
  '+y',
  ' n',
  '@@ -38,3 +40,2 @@',
  ' k',
  '-z',
  ' q',
  ''
].join('\n')

const frameOf = async (client: Awaited<ReturnType<typeof connect>>): Promise<Frame> =>
  client.next(frame => frame.method === 'review.diff', 'the review.diff frame')

describe('raised from a diff', () => {
  it('sends what the parser read: the numbered hunks, the kind, the path and the gateway’s own anchors', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)

    const raised = await raise(h, { diff: SETTINGS })

    expect(raised.status).toBe(200)

    const frame = await frameOf(client)
    const params = frame.params as Json
    const parsed = parseDiff(SETTINGS)

    expect(params).toMatchObject({ v: 1, optional: false, kind: 'modify', path: 'app/settings.py' })
    expect(params).not.toHaveProperty('old_path')
    expect(params.hunks).toEqual(parsed.hunks)
    expect((params.hunks as Json[]).map(hunk => hunk.id)).toEqual(['h1', 'h2'])
    // Neither is pinned: old start 3 and context after the change.
    expect((params.hunks as Json[]).every(hunk => !('anchor' in hunk))).toBe(true)
    // The frame is one the contract's own model accepts.
    expect(matchesParams('review.diff', params)).toBe(true)
  })

  it('pins the last hunk of a new, a deleted and an appended-to file, as the examples show', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)

    await raise(h, { diff: '--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1,2 @@\n+one\n+two\n' })
    await raise(h, { diff: '--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n' })

    const frames = client.frames.filter(frame => frame.method === 'review.diff')

    expect(frames).toHaveLength(2)
    expect(frames.map(frame => [frame.params?.kind, frame.params?.path])).toEqual([
      ['new', 'docs/new.md'],
      ['delete', 'gone.txt']
    ])
    expect(frames.map(frame => (frame.params?.hunks as Json[])[0]!.anchor)).toEqual(['both', 'both'])

    const appended = await raise(h, { diff: '@@ -2,1 +2,2 @@\n b\n+X\n', path: 'f.txt' })

    expect(appended.status).toBe(200)
    expect(client.frames.filter(frame => frame.method === 'review.diff').at(-1)?.params).toMatchObject({
      kind: 'modify',
      path: 'f.txt',
      hunks: [{ id: 'h1', anchor: 'end' }]
    })
  })

  it('carries `start` for a hunk at the top of the file', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)
    await raise(h, { diff: '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -9,2 +9,3 @@\n z\n y\n+tail\n' })

    expect(((await frameOf(client)).params?.hunks as Json[]).map(hunk => hunk.anchor)).toEqual(['start', 'end'])
  })

  it('says rename with the previous path', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)
    await raise(h, {
      diff: 'similarity index 80%\nrename from old.txt\nrename to new/name.txt\n--- a/old.txt\n+++ b/new/name.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n'
    })

    const params = (await frameOf(client)).params as Json

    expect(params).toMatchObject({ kind: 'rename', path: 'new/name.txt', old_path: 'old.txt' })
    expect(matchesParams('review.diff', params)).toBe(true)
  })

  it('lets the caller word the request and set the expiry', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)
    await raise(h, {
      diff: SETTINGS,
      title: 'Currency and retries',
      summary: 'Two changes.',
      expires_at: 4_000_000_000
    })

    expect((await frameOf(client)).params).toMatchObject({
      title: 'Currency and retries',
      summary: 'Two changes.',
      expires_at: 4_000_000_000
    })
  })

  it.each([
    ['a binary diff', { diff: 'Binary files a/x and b/x differ\n' }, /binary/],
    ['two files', { diff: `${SETTINGS}--- a/other\n+++ b/other\n@@ -1 +1 @@\n-a\n+b\n` }, /more than one file/],
    ['a hunk without context in the middle', { diff: '--- a/f\n+++ b/f\n@@ -5 +5 @@\n-a\n+b\n' }, /no context line/],
    ['bare hunks without a path', { diff: '@@ -1,2 +1,2 @@\n a\n-b\n+c\n' }, /path is required/],
    ['a hidden character', { diff: '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+c\u202ed\n d\n' }, /U\+202E/],
    [
      'an executable file',
      { diff: 'new file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+x\n' },
      /executable/
    ],
    [
      'a .git path',
      { diff: '--- a/.git/config\n+++ b/.git/config\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n' },
      /\.git segment/
    ]
  ])('refuses %s with a 400 that says why, and sends nothing', async (_name, params, why) => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)

    const refused = await raise(h, params)

    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: 'diff_refused', detail: expect.stringMatching(why) })
    expect(client.frames.some(frame => frame.method === 'review.diff')).toBe(false)
    expect((await (await fetch(`${h.url}/__fake/state`)).json()).interactiveRequests).toEqual([])
  })

  it('is 409 when no connection advertised review.diff, and nothing is raised', async () => {
    const h = await start()
    const client = await connect(h)

    await client.call('client.capabilities', { server_requests: true, confirm: ['plain'], requests: ['review.draft'] })

    const refused = await raise(h, { diff: SETTINGS })

    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'no_capable_client', outcome: 'unavailable' })
  })
})

describe('the answer', () => {
  const raised = async (diff = SETTINGS) => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)

    const { id } = (await (await raise(h, { diff })).json()) as { id: string }

    return { h, client, id }
  }

  it('hands the agent the patch of exactly the approved hunks and each hunk’s decision', async () => {
    const { h, client, id } = await raised()
    const answer = await client.call('request.answer', {
      id,
      result: { decision: 'approved', hunks: { h2: 'rejected', h1: 'approved' } }
    })

    expect(answer.result).toEqual({ status: 'ok' })

    const seen = await view(h, id)
    const parsed = parseDiff(SETTINGS)

    expect(seen).toMatchObject({ open: false, outcome: 'answered', refusals: [] })
    // In the request's order and with the gateway's ids, whatever order the client sent them in.
    expect(Object.keys(seen.answer.hunks)).toEqual(['h1', 'h2'])
    expect(seen.answer).toMatchObject({ decision: 'approved', hunks: { h1: 'approved', h2: 'rejected' } })
    expect(seen.answer.approved_patch).toBe(composePatch(parsed.head, parsed.hunks, ['h1']))
    expect(seen.answer.approved_patch).toBe(
      [
        'diff --git a/app/settings.py b/app/settings.py',
        '--- a/app/settings.py',
        '+++ b/app/settings.py',
        '@@ -3,4 +3,4 @@ class Settings:',
        '     name = "booking"',
        '-    currency = "USD"',
        '+    currency = "EUR"',
        '     locale = "nl-NL"',
        '     debug = False',
        ''
      ].join('\n')
    )
  })

  it('moves the new-side start of a hunk back by the net change of the rejected hunks before it', async () => {
    const { h, client, id } = await raised(THREE)

    await client.call('request.answer', {
      id,
      result: { decision: 'approved', hunks: { h1: 'rejected', h2: 'approved', h3: 'approved' } }
    })

    const patch = (await view(h, id)).answer.approved_patch as string

    // h1 added two lines and is left out: 22 -> 20 and 40 -> 38.
    expect(patch.split('\n').filter(line => line.startsWith('@@'))).toEqual([
      '@@ -20,3 +20,3 @@ def f():',
      '@@ -38,3 +38,2 @@'
    ])
  })

  it('has no patch for a rejection, only the decisions', async () => {
    const { h, client, id } = await raised()

    await client.call('request.answer', {
      id,
      result: { decision: 'rejected', hunks: { h1: 'rejected', h2: 'rejected' } }
    })

    const seen = await view(h, id)

    expect(seen).toMatchObject({
      outcome: 'answered',
      answer: { decision: 'rejected', hunks: { h1: 'rejected', h2: 'rejected' } }
    })
    expect(seen.answer).not.toHaveProperty('approved_patch')
  })

  it('takes the answer on the request’s own reply frame too', async () => {
    const { h, client, id } = await raised()
    const frame = await frameOf(client)

    client.socket.send(
      `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { decision: 'approved', hunks: { h1: 'approved', h2: 'approved' } } })}\n`
    )
    await until('the reply frame to settle the request', async () => (await view(h, id)).open === false)

    const seen = await view(h, id)

    expect(seen.outcome).toBe('answered')
    expect(seen.answer.approved_patch).toContain('+    backoff = 2')
  })

  it.each([
    ['a hunk left out', { decision: 'approved', hunks: { h1: 'approved' } }, 'hunk:h2:missing'],
    [
      'a hunk the request lacks',
      { decision: 'approved', hunks: { h1: 'approved', h2: 'approved', h3: 'approved' } },
      'hunk:h3:unknown'
    ],
    [
      'an unknown id judged before a missing one',
      { decision: 'approved', hunks: { h1: 'approved', h3: 'approved' } },
      'hunk:h3:unknown'
    ],
    [
      'an approval with nothing approved',
      { decision: 'approved', hunks: { h1: 'rejected', h2: 'rejected' } },
      'decision:inconsistent'
    ],
    [
      'a rejection with a hunk approved',
      { decision: 'rejected', hunks: { h1: 'approved', h2: 'rejected' } },
      'decision:inconsistent'
    ],
    ['no hunks at all', { decision: 'rejected', hunks: {} }, 'bad_shape'],
    ['a skip', { decision: 'skipped', hunks: { h1: 'rejected', h2: 'rejected' } }, 'bad_shape'],
    ['a comment', { decision: 'rejected', comment: 'No.', hunks: { h1: 'rejected', h2: 'rejected' } }, 'bad_shape']
  ])('refuses %s with 4034 and the reason, and the request stays open', async (_name, result, reason) => {
    const { h, client, id } = await raised()
    const refused = await client.call('request.answer', { id, result })

    expect(refused.error).toEqual({ code: 4034, message: 'answer refused', data: { reason } })

    const seen = await view(h, id)

    expect(seen).toMatchObject({ open: true, refusals: [reason] })
    expect(seen).not.toHaveProperty('answer')
  })

  it('is the contract’s example when raised without a diff, and approves its own patch', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)

    const { id } = (await (await post(`${h.url}/__fake/request`, { method: 'review.diff' })).json()) as { id: string }
    const params = (await frameOf(client)).params as Json

    expect(params).toMatchObject({ kind: 'modify', path: 'app/settings.py' })
    expect((params.hunks as Json[]).map(hunk => hunk.id)).toEqual(['h1', 'h2'])
    await client.call('request.answer', {
      id,
      result: { decision: 'approved', hunks: { h1: 'rejected', h2: 'approved' } }
    })

    const patch = (await view(h, id)).answer.approved_patch as string

    expect(
      patch.startsWith(
        'diff --git a/app/settings.py b/app/settings.py\n--- a/app/settings.py\n+++ b/app/settings.py\n@@ -20,3 +20,4 @@'
      )
    ).toBe(true)
    expect(patch).not.toContain('USD')
  })

  it('composes a new file, a deletion and a rename from the head the diff said', async () => {
    const cases: [string, string, string][] = [
      [
        '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n',
        'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n',
        '+a\n+b\n'
      ],
      [
        '--- a/g.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n',
        'diff --git a/g.txt b/g.txt\ndeleted file mode 100644\n--- a/g.txt\n+++ /dev/null\n',
        '-a\n-b\n'
      ],
      [
        'similarity index 90%\nrename from o.txt\nrename to p.txt\n--- a/o.txt\n+++ b/p.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n',
        'diff --git a/o.txt b/p.txt\nsimilarity index 90%\nrename from o.txt\nrename to p.txt\n--- a/o.txt\n+++ b/p.txt\n',
        '+c\n'
      ]
    ]

    for (const [diff, head, tail] of cases) {
      const { h, client, id } = await raised(diff)

      await client.call('request.answer', { id, result: { decision: 'approved', hunks: { h1: 'approved' } } })

      const patch = (await view(h, id)).answer.approved_patch as string

      expect(patch.startsWith(head)).toBe(true)
      expect(patch.endsWith(tail) || patch.includes(tail)).toBe(true)
    }
  })
})

describe('over the handle', () => {
  it('raises from a diff, and `settled` resolves with the patch', async () => {
    const h = await start()
    const client = await connect(h)

    await advertise(client)

    const raisedOnHandle = h.gateway.raiseInteractive({ method: 'review.diff', params: { diff: SETTINGS } })

    expect(raisedOnHandle.kind).toBe('raised')

    if (raisedOnHandle.kind !== 'raised') {
      return
    }

    await client.call('request.answer', {
      id: raisedOnHandle.id,
      result: { decision: 'approved', hunks: { h1: 'approved', h2: 'approved' } }
    })

    const outcome = await raisedOnHandle.settled

    expect(outcome.outcome).toBe('answered')
    expect(outcome.answer?.approved_patch).toBe(
      composePatch(parseDiff(SETTINGS).head, parseDiff(SETTINGS).hunks, ['h1', 'h2'])
    )
  })

  it('says `refused` for a diff the gateway would not build', () => {
    return start().then(h => {
      expect(h.gateway.raiseInteractive({ method: 'review.diff', params: { diff: 'nonsense' } })).toMatchObject({
        kind: 'refused',
        error: 'diff_refused'
      })
    })
  })

  it('is available on a gateway that knows the passkey level too', async () => {
    const h = await startPasskeyGateway({ auth: 'token', token: 'secret' })
    const client = await connect(h, null, '?token=secret')

    await advertise(client)

    expect((await raise(h, { diff: SETTINGS })).status).toBe(200)
    expect((await frameOf(client)).params).toMatchObject({ kind: 'modify', path: 'app/settings.py' })
  })
})
