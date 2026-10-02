/**
 * What the watcher decides, and what it refuses to decide.
 *
 * Almost every case here is a NON-notification: a chat somebody is already
 * reading, an event that arrived twice, a device that turned that type off, a
 * bot in a loop. Those are the failures a person actually feels — a phone that
 * buzzes for something they are looking at is worse than one that does not
 * buzz at all — so they are the ones pinned down.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import type { PushMessage } from './expo'
import { PUSH_SECTION_VERSION, type PushRegistration } from './registrations'
import { PUSH_STATE_VERSION, type PushState } from './state'
import { PushWatcher, type WatcherLink } from './watcher'

interface Sent {
  message: PushMessage
  installations: string[]
}

const registrationRow = (over: Record<string, unknown> = {}) => ({
  v: PUSH_SECTION_VERSION,
  transport: 'expo',
  token: 'ExponentPushToken[abc]',
  platform: 'ios',
  types: { message: true, request: true, dm: true, cron: true },
  preview: false,
  updatedAt: 100,
  ...over
})

const CRON_HEADER =
  '[Cronjob "Morning digest" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]'

interface Fixture {
  watcher: PushWatcher
  sent: Sent[]
  state: PushState
  calls: { method: string; params: Record<string, unknown> }[]
  tailCalls: { sessionId: string; limit: number }[]
  setSeen: (seen: Record<string, number>) => void
  setRegistrations: (rows: Record<string, unknown>) => void
  setHistory: (text: string) => void
  setTail: (rows: Record<string, unknown>[] | null) => void
  setPendingApprovals: (rows: Record<string, unknown>[]) => void
  setResumeSnapshot: (snapshot: Record<string, unknown>) => void
}

const NOW = 1_800_000_000

function fixture(
  options: { registrations?: Record<string, unknown>; seen?: Record<string, number>; withTail?: boolean } = {}
): Fixture {
  const sent: Sent[] = []
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const tailCalls: { sessionId: string; limit: number }[] = []
  const state: PushState = { v: PUSH_STATE_VERSION, seq: {}, sent: {}, invalid: {}, tickets: [] }
  let registrations: Record<string, unknown> = options.registrations ?? { 'dev-1': registrationRow() }
  let seen: Record<string, number> = options.seen ?? {}
  let historyText = 'What is the weather?'
  let tailRows: Record<string, unknown>[] | null = null
  let pendingApprovals: Record<string, unknown>[] = []
  let resumeSnapshot: Record<string, unknown> = {}

  const link: WatcherLink = {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })

      if (method === 'profiles.list') {
        return {
          profiles: [
            {
              name: 'researcher',
              display_name: 'Researcher',
              is_default: true,
              canonical_session: { id: 'stored-r', resolved_id: 'live-r' },
              ui_meta: { 'hermie-app': { v: 1, push: { registrations, seen } } },
              ui_meta_revisions: { 'hermie-app': 3 }
            },
            {
              name: 'writer',
              display_name: 'Writer',
              canonical_session: { id: 'stored-w', resolved_id: 'live-w' }
            }
          ]
        } as T
      }

      if (method === 'session.resume') {
        // The snapshot belongs to `researcher`'s chat only, so a test can tell
        // one notification from one that was sent per watched chat.
        return {
          session_id: String(params.session_id),
          stored_session_id: 'stored',
          ...(params.session_id === 'live-r' ? resumeSnapshot : {})
        } as T
      }

      if (method === 'approval.pending') {
        return { approvals: params.session_id === 'live-r' ? pendingApprovals : [] } as T
      }

      if (method === 'session.history') {
        return {
          messages: [
            { role: 'user', text: historyText },
            { role: 'assistant', text: 'here you go' }
          ]
        } as T
      }

      throw new Error(`unexpected ${method}`)
    }
  }

  const watcher = new PushWatcher({
    link,
    state,
    save: async () => undefined,
    sender: {
      async send(targets: readonly PushRegistration[], message: PushMessage) {
        sent.push({ message, installations: targets.map(target => target.installationId) })

        return { dead: [] }
      }
    },
    now: () => NOW,
    sleep: async () => undefined,
    log: () => undefined,
    registrationTtlMs: 0,
    ...(options.withTail
      ? {
          fetchTail: async (sessionId: string, limit: number) => {
            tailCalls.push({ sessionId, limit })

            return tailRows
          }
        }
      : {})
  })

  return {
    watcher,
    sent,
    state,
    calls,
    tailCalls,
    setSeen: value => {
      seen = value
    },
    setRegistrations: value => {
      registrations = value
    },
    setHistory: text => {
      historyText = text
    },
    setTail: rows => {
      tailRows = rows
    },
    setPendingApprovals: rows => {
      pendingApprovals = rows
    },
    setResumeSnapshot: snapshot => {
      resumeSnapshot = snapshot
    }
  }
}

const turn = (
  sessionId: string,
  seq: number,
  payload: Record<string, unknown> = { text: 'here you go', status: 'complete' }
) => ({
  type: 'message.complete',
  session_id: sessionId,
  seq,
  payload
})

let f: Fixture

beforeEach(async () => {
  f = fixture()
  await f.watcher.resumeAll()
})

describe('resuming', () => {
  it('watches every bot’s canonical Bot Chat, by its resolved id', async () => {
    expect(f.watcher.watched.map(bot => bot.name)).toEqual(['researcher', 'writer'])
    // `resolved_id` is the live compression tip; the registry row is the wrong
    // end of a chat that has been compressed.
    expect(f.calls.filter(call => call.method === 'session.resume').map(call => call.params.session_id)).toEqual([
      'live-r',
      'live-w'
    ])
  })

  it('reads the registrations off the default profile', () => {
    expect(f.watcher.registrations.map(row => row.installationId)).toEqual(['dev-1'])
  })

  it('re-lists when the gateway says the session store moved', async () => {
    const before = f.calls.filter(call => call.method === 'profiles.list').length
    f.watcher.onEvent({ type: 'sessions.changed' })
    await f.watcher.settle()

    expect(f.calls.filter(call => call.method === 'profiles.list').length).toBeGreaterThan(before)
  })
})

describe('a finished turn', () => {
  it('notifies the registered device, saying who and not what', async () => {
    f.watcher.onEvent(turn('live-r', 7))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.message.title).toBe('Researcher')
    expect(f.sent[0]?.message.body).toBe('sent you a message')
    // Preview is off, so the reply itself never leaves the gateway.
    expect(JSON.stringify(f.sent[0])).not.toContain('here you go')
  })

  it('carries the text only to a device that asked for it', async () => {
    f.setRegistrations({ 'dev-1': registrationRow({ preview: true }) })
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 7))
    await f.watcher.settle()

    expect(f.sent[0]?.message.body).toBe('here you go')
  })

  it('says nothing when a device reported the chat on screen', async () => {
    f.setSeen({ 'dev-1': NOW - 5 })
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 7))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(0)
  })

  it('re-reads the heartbeat across the grace pause, so an app that is opening claims the chat', async () => {
    f.watcher.onEvent(turn('live-r', 7))
    // The stamp lands DURING the pause, which is the case the pause exists for.
    f.setSeen({ 'dev-1': NOW - 1 })
    await f.watcher.settle()

    expect(f.sent).toHaveLength(0)
  })

  it('sends once when the same turn arrives twice', async () => {
    f.watcher.onEvent(turn('live-r', 7))
    f.watcher.onEvent(turn('live-r', 7))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
  })

  it('reads a cron delivery as a cron run that finished, not as a message', async () => {
    f.setHistory(`${CRON_HEADER}\n\nEverything is fine.`)
    f.watcher.onEvent(turn('live-r', 8))
    await f.watcher.settle()

    // The finer of the two facts is what the payload names — the coarse `cron`
    // is still in the AUDIENCE, which is what the next case is about.
    expect(f.sent[0]?.message.data.type).toBe('cron_done')
    expect(f.sent[0]?.message.body).toBe('cron “Morning digest” reported')
  })

  it('says a cron run failed when the turn ended in an error', async () => {
    f.setHistory(`${CRON_HEADER}\n\nreport`)
    f.watcher.onEvent(turn('live-r', 9, { status: 'error', error: 'the model refused' }))
    await f.watcher.settle()

    expect(f.sent[0]?.message.data.type).toBe('cron_failed')
    expect(f.sent[0]?.message.body).toBe('cron “Morning digest” failed')
  })

  it('says the cron was a fact, because the header it matched is fixed text', async () => {
    f.setHistory(`${CRON_HEADER}\n\nreport`)
    f.watcher.onEvent(turn('live-r', 46))
    await f.watcher.settle()

    const data = f.sent[0]?.message.data as Record<string, unknown>

    expect(data.cron).toBe(true)
    expect(data.cronCertain).toBe(true)
    // And the line is allowed to name the run, because of that.
    expect(f.sent[0]?.message.body).toBe('cron “Morning digest” reported')
  })

  it('says nothing about cron at all for an ordinary turn', async () => {
    f.watcher.onEvent(turn('live-r', 47))
    await f.watcher.settle()

    const data = f.sent[0]?.message.data as Record<string, unknown>

    expect(data.cron).toBeUndefined()
    expect(data.cronCertain).toBeUndefined()
  })

  it('still reaches a device that only ever asked for the coarse cron switch', async () => {
    // The registration predates `cron_done` and `cron_failed` entirely. Adding
    // a finer type must never be how somebody's phone goes quiet.
    f.setRegistrations({ 'dev-1': registrationRow({ types: { cron: true } }) })
    f.setHistory(`${CRON_HEADER}\n\nreport`)
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 40))
    await f.watcher.settle()

    expect(f.sent[0]?.installations).toEqual(['dev-1'])
    expect(f.sent[0]?.message.data.type).toBe('cron_done')
  })

  it('reaches a device that asked only about failures, and only for the failure', async () => {
    f.setRegistrations({ 'dev-1': registrationRow({ types: { cron_failed: true } }) })
    f.setHistory(`${CRON_HEADER}\n\nreport`)
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 41))
    f.watcher.onEvent(turn('live-r', 42, { status: 'error', error: 'the model refused' }))
    await f.watcher.settle()

    expect(f.sent.map(entry => entry.message.data.type)).toEqual(['cron_failed'])
  })

  it('sends one notification to a device that asked for both the coarse and the fine switch', async () => {
    // The union is where one device would otherwise hear the same fact twice.
    f.setRegistrations({ 'dev-1': registrationRow({ types: { cron: true, cron_done: true } }) })
    f.setHistory(`${CRON_HEADER}\n\nreport`)
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 43))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.installations).toEqual(['dev-1'])
  })

  it('leaves an ordinary turn on the type it always had', async () => {
    // `typeForTurn` only splits a CRON turn. A plain finished turn must not
    // start answering to a cron switch because the outcome happens to be known.
    f.watcher.onEvent(turn('live-r', 44, { status: 'error', error: 'boom' }))
    await f.watcher.settle()

    expect(f.sent[0]?.message.data.type).toBe('message')
  })

  it('reads a bot-to-bot delivery as a DM, and names the sender', async () => {
    f.setHistory('Message from 🤖 Writer (@writer): can you check this')
    f.watcher.onEvent(turn('live-r', 10))
    await f.watcher.settle()

    expect(f.sent[0]?.message.data.type).toBe('dm')
    expect(f.sent[0]?.message.body).toBe('heard from Writer')
  })

  /**
   * And the app never asks to hear about one.
   *
   * The daemon still KNOWS the `dm` type — it reads its own list, and an
   * operator running `hermie-web --push` for something else may want it — but a
   * registration written by this app carries no `dm` key at all, and an absent
   * type reads as off. The bag below is what `pushTypesOf` in `gateway-client`
   * emits, written out rather than imported because this package deliberately
   * does not depend on that one; `push.test.ts` there pins the other half, that
   * the key really is dropped.
   *
   * So the owner's rule that bot-to-bot must not raise a notification is kept by
   * the registration rather than by the daemon, and this is the test that says
   * so: the same delivery, the same watcher, a real device's types, and nothing
   * goes out.
   *
   * The device is not deaf — an ordinary reply on the same registration still
   * buzzes — which is what separates this from a watcher that has stopped
   * working.
   */
  it('sends nothing for a bot-to-bot delivery to a device this app registered', async () => {
    f.setRegistrations({
      'dev-1': registrationRow({
        types: { message: true, request: true, cron: true, cron_done: true, cron_failed: true }
      })
    })
    f.setHistory('Message from 🤖 Writer (@writer): can you check this')
    f.watcher.onEvent(turn('live-r', 20))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(0)

    f.setHistory('What is the weather?')
    f.watcher.onEvent(turn('live-r', 21))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.message.data.type).toBe('message')
  })

  it('does not defer a DM to the heartbeat', async () => {
    // A question with a countdown on it is worth a buzz even if the chat is
    // open on a tablet in another room.
    f.setSeen({ 'dev-1': NOW - 1 })
    f.setHistory('Message from 🤖 Writer (@writer): urgent')
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 11))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
  })

  it('leaves a device that turned that type off alone', async () => {
    f.setRegistrations({ 'dev-1': registrationRow({ types: { message: true } }) })
    f.setHistory(`${CRON_HEADER}\n\nreport`)
    await f.watcher.resumeAll()
    f.watcher.onEvent(turn('live-r', 12))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(0)
  })

  it('says which session it was, and that the session is the canonical chat', async () => {
    f.watcher.onEvent(turn('live-r', 45))
    await f.watcher.settle()

    const data = f.sent[0]?.message.data as Record<string, unknown>

    // Both spellings: `session` is what this daemon has always written, and
    // `sessionId` is the plugin's — the app reads either.
    expect(data.session).toBe('live-r')
    expect(data.sessionId).toBe('live-r')
    // A fact rather than a guess: the only sessions this daemon resumes are the
    // canonical Bot Chats it read off the roster.
    expect(data.sessionKind).toBe('canonical')
  })

  it('ignores a session nobody is watching', async () => {
    f.watcher.onEvent(turn('some-other-session', 3))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(0)
  })

  it('does not read the transcript when nobody is registered', async () => {
    f.setRegistrations({})
    await f.watcher.resumeAll()
    const before = f.calls.filter(call => call.method === 'session.history').length
    f.watcher.onEvent(turn('live-r', 13))
    await f.watcher.settle()

    expect(f.calls.filter(call => call.method === 'session.history').length).toBe(before)
  })
})

describe('a request opening', () => {
  const approval = (id = 'srq-1') => ({
    id,
    method: 'approval',
    params: { session_id: 'live-r', command: 'rm -rf ./build' },
    replayed: false
  })

  it('notifies, and carries the request id for the app to re-validate', async () => {
    f.watcher.onServerRequest(approval())
    await f.watcher.settle()

    expect(f.sent[0]?.message.body).toBe('is waiting for your approval')
    expect(f.sent[0]?.message.data.requestId).toBe('srq-1')
    expect(f.sent[0]?.message.categoryId).toBe('hermie.request')
  })

  it('does not buzz again when a reconnect re-delivers the same open request', async () => {
    f.watcher.onServerRequest(approval())
    await f.watcher.settle()
    f.watcher.onServerRequest({ ...approval(), replayed: true })
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
  })

  it('is not suppressed by the heartbeat', async () => {
    f.setSeen({ 'dev-1': NOW - 1 })
    await f.watcher.resumeAll()
    f.watcher.onServerRequest(approval('srq-2'))
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
  })

  it('names the session on a request too, so a tap lands on the chat that asked', async () => {
    const asked = fixture()
    await asked.watcher.resumeAll()
    asked.watcher.onServerRequest({
      id: 'srq-9',
      method: 'approval',
      params: { session_id: 'live-r', request_id: 'req-9', command: 'rm -rf /' },
      replayed: false
    })
    await asked.watcher.settle()

    const data = asked.sent[0]?.message.data as Record<string, unknown>

    expect(data.sessionId).toBe('live-r')
    expect(data.sessionKind).toBe('canonical')
  })

  it('ignores a server request that is not a question for the owner', async () => {
    f.watcher.onServerRequest({
      id: 'srq-9',
      method: 'terminal.read',
      params: { session_id: 'live-r' },
      replayed: false
    })
    await f.watcher.settle()

    expect(f.sent).toHaveLength(0)
  })
})

describe('classifying a finished turn', () => {
  it('prefers five rows of the REST tail to the unpaginated transcript', async () => {
    const tailed = fixture({ withTail: true })
    await tailed.watcher.resumeAll()
    tailed.setTail([
      { role: 'user', content: `${CRON_HEADER}\n\nAll clear.` },
      { role: 'assistant', content: 'read it' }
    ])
    tailed.watcher.onEvent(turn('live-r', 7))
    await tailed.watcher.settle()

    expect(tailed.tailCalls).toEqual([{ sessionId: 'live-r', limit: 5 }])
    // `session.history` returns the WHOLE chat; on a long one that is the
    // transcript downloaded to read its last row, once per turn.
    expect(tailed.calls.some(call => call.method === 'session.history')).toBe(false)
    expect(tailed.sent[0]?.message.data.type).toBe('cron_done')
  })

  it('falls back to session.history for a gateway with no REST surface', async () => {
    const tailed = fixture({ withTail: true })
    await tailed.watcher.resumeAll()
    // `null`, which is what the app's own `fetchMessages` answers there.
    tailed.setTail(null)
    tailed.setHistory(`${CRON_HEADER}\n\nAll clear.`)
    tailed.watcher.onEvent(turn('live-r', 7))
    await tailed.watcher.settle()

    expect(tailed.calls.some(call => call.method === 'session.history')).toBe(true)
    expect(tailed.sent[0]?.message.data.type).toBe('cron_done')
  })
})

describe('open questions, without asking to receive them', () => {
  it('takes the approval a resume already knew about', async () => {
    const resumed = fixture()
    resumed.setResumeSnapshot({ pending_approval: { request_id: 'appr-7', command: 'rm -rf ./build' } })
    await resumed.watcher.resumeAll()
    await resumed.watcher.settle()

    expect(resumed.sent).toHaveLength(1)
    expect(resumed.sent[0]?.message.body).toBe('is waiting for your approval')
    expect(resumed.sent[0]?.message.data.requestId).toBe('appr-7')
  })

  it('takes one the poll finds', async () => {
    f.setPendingApprovals([{ request_id: 'appr-9', command: 'rm -rf ./build' }])
    await f.watcher.pollApprovals()
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.message.data.requestId).toBe('appr-9')
  })

  it('buzzes once however many routes carry the same question', async () => {
    // A live frame, a resume's `open_requests` and the poll all name the same
    // queue entry under three different envelopes.
    f.setPendingApprovals([{ request_id: 'appr-9', command: 'rm -rf ./build' }])
    f.watcher.onServerRequest({
      id: 'srq-1',
      method: 'approval',
      params: { session_id: 'live-r', request_id: 'appr-9' },
      replayed: false
    })
    await f.watcher.settle()
    f.watcher.onServerRequest({
      id: 'srq-2',
      method: 'approval',
      params: { session_id: 'live-r', request_id: 'appr-9' },
      replayed: true
    })
    await f.watcher.settle()
    await f.watcher.pollApprovals()
    await f.watcher.settle()

    expect(f.sent).toHaveLength(1)
  })

  it('does not poll while nobody is registered', async () => {
    f.setRegistrations({})
    f.setPendingApprovals([{ request_id: 'appr-9' }])
    await f.watcher.resumeAll()
    const before = f.calls.length
    await f.watcher.pollApprovals()

    // A poll that would notify nobody is load on somebody's gateway for nothing.
    expect(f.calls.length).toBe(before)
    expect(f.sent).toHaveLength(0)
  })

  it('survives a gateway with no approval queue to read', async () => {
    const broken = fixture()
    await broken.watcher.resumeAll()
    broken.setPendingApprovals([])
    await expect(broken.watcher.pollApprovals()).resolves.toBeUndefined()
  })
})

describe('rate limiting', () => {
  it('stops one device being buzzed by a bot in a loop', async () => {
    const limited = fixture()
    await limited.watcher.resumeAll()

    for (let seq = 1; seq <= 20; seq += 1) {
      limited.watcher.onServerRequest({
        id: `srq-${String(seq)}`,
        method: 'approval',
        params: { session_id: 'live-r' },
        replayed: false
      })
      await limited.watcher.settle()
    }

    expect(limited.sent.length).toBeLessThan(20)
    expect(limited.sent.length).toBeGreaterThan(0)
  })
})

describe('a dead address', () => {
  it('is remembered, and not tried again', async () => {
    const state: PushState = { v: PUSH_STATE_VERSION, seq: {}, sent: {}, invalid: {}, tickets: [] }
    const sent: Sent[] = []
    const link: WatcherLink = {
      async request<T>(method: string): Promise<T> {
        if (method === 'profiles.list') {
          return {
            profiles: [
              {
                name: 'researcher',
                is_default: true,
                canonical_session: { id: 'stored-r', resolved_id: 'live-r' },
                ui_meta: { 'hermie-app': { v: 1, push: { registrations: { 'dev-1': registrationRow() } } } }
              }
            ]
          } as T
        }

        if (method === 'session.resume') {
          return {} as T
        }

        return { messages: [{ role: 'user', text: 'hello' }] } as T
      }
    }
    const watcher = new PushWatcher({
      link,
      state,
      save: async () => undefined,
      sender: {
        async send(targets, message) {
          sent.push({ message, installations: targets.map(target => target.installationId) })

          return { dead: ['dev-1'] }
        }
      },
      now: () => NOW,
      sleep: async () => undefined,
      log: () => undefined,
      registrationTtlMs: 0
    })

    await watcher.resumeAll()
    watcher.onEvent(turn('live-r', 1))
    await watcher.settle()
    watcher.onEvent(turn('live-r', 2))
    await watcher.settle()

    expect(state.invalid['dev-1']).toBe(NOW)
    expect(sent).toHaveLength(1)
  })
})
