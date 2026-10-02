/**
 * Stream scenarios for the golden corpus: `contract/transcript/streams/*.json`.
 *
 * Each scenario starts the fake gateway in-process, drives it over a real
 * WebSocket the way the app's chat controller does (roster, resume, history,
 * replay watermark, submit, answer), and writes down three things:
 *
 * - `frames`: every frame the server sent to the recorded client, in arrival
 *   order, tagged with the connection it arrived on;
 * - `steps`: every transcript-engine call the client made because of them, in
 *   order, with the current state left implicit (see `contract/README.md`);
 * - `checkpoints` (what `visibleItems` shows at each verbosity at the end of
 *   each phase) and `final` (the whole `ChatState` after the last step).
 *
 * Determinism: `crypto.randomUUID` is replaced by a counter-seeded generator
 * and `Date.now` is pinned before the gateway is loaded, so ids, epochs and
 * timestamps are the same on every run. Every engine call gets an explicit
 * `now`. Frame order comes from the gateway's own timers; the scenarios avoid
 * anything that would race them (the reconnect scenario disconnects while the
 * chat is idle and lets a second device run the turn it then replays).
 *
 *   tsx packages/fake-gateway/scripts/dump-frames.ts --out <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

import {
  answerRequest,
  applyEvent,
  applyResumeSnapshot,
  applyServerRequest,
  beginLocalTurn,
  type ChatState,
  confirmSubmit,
  createChatState,
  reconcile,
  reconcileTail,
  rowsToItems,
  type ServerRequest,
  type TranscriptEvent,
  type TranscriptRow,
  type Verbosity,
  visibleItems
} from '@hermie/transcript'
import { WebSocket } from 'ws'

import { prettyJson } from '../../../scripts/golden/canonical-json'
import type { FakeGateway } from '../src/index'

/** The same instant the transcript corpus is pinned to: 2026-09-21T14:13:20Z. */
const PINNED_NOW = 1_790_000_000_000
/** Each engine step is one second after the one before it. */
const STEP_MS = 1_000
const TOKEN = 'golden'
const TIMEOUT_MS = 10_000
/** The controller's `TAIL_ROW_LIMIT`: how many rows a tail sweep reads. */
const TAIL_ROW_LIMIT = 30

// ── determinism, installed before the gateway module is evaluated ───────────

const nodeCrypto = createRequire(import.meta.url)('node:crypto') as { randomUUID: () => string }
let uuidCounter = 0

/** A v4-shaped id whose leading hex varies with every call (the gateway slices prefixes). */
function seededUuid(): string {
  uuidCounter += 1

  let hex = ''
  let hash = 0x811c9dc5

  for (let round = 0; hex.length < 32; round += 1) {
    for (const char of `golden-${uuidCounter}-${round}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
    }

    hex += hash.toString(16).padStart(8, '0')
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

nodeCrypto.randomUUID = seededUuid
syncBuiltinESMExports()
Date.now = () => PINNED_NOW

const { startFakeGateway } = await import('../src/index')

// ── one recorded client ──────────────────────────────────────────────────────

type Json = Record<string, unknown>

interface Step {
  op: string
  args: unknown[]
  /** Index into `frames` of the frame that caused this step, when one did. */
  frame?: number
}

interface Checkpoint {
  after: number
  label: string
  visible: Record<Verbosity, unknown>
}

interface Recording {
  /** `connection` numbers the WebSocket; `"rest"` marks an HTTP body the client fetched. */
  frames: { connection: number | 'rest'; frame: unknown }[]
  steps: Step[]
  checkpoints: Checkpoint[]
}

const LEVELS: Verbosity[] = ['quiet', 'normal', 'verbose']

class Client {
  readonly recording: Recording = { frames: [], steps: [], checkpoints: [] }
  state: ChatState
  runtimeId = ''
  storedId = ''
  resolvedId = ''

  private socket: WebSocket | null = null
  private connection = 0
  private requestSeq = 0
  private readonly pending = new Map<string, (frame: Json, index: number) => void>()
  private readonly waiters = new Set<() => void>()
  private readonly answers: { approval?: string; clarify?: Record<string, string> }

  constructor(
    private readonly gateway: FakeGateway,
    readonly profile: string,
    answers: { approval?: string; clarify?: Record<string, string> } = {}
  ) {
    this.answers = answers
    this.state = createChatState(profile, '', '')
  }

  private now(): number {
    return PINNED_NOW + this.recording.steps.length * STEP_MS
  }

  /** Run one engine call on the current state and write it down. */
  step(op: string, args: unknown[], fn: (state: ChatState) => ChatState, frame?: number): void {
    this.state = fn(this.state)
    this.recording.steps.push({ op, args, ...(frame === undefined ? {} : { frame }) })
  }

  checkpoint(label: string): void {
    const visible = {} as Record<Verbosity, unknown>

    for (const level of LEVELS) {
      visible[level] = visibleItems(this.state, { level, showBotToBot: true, showThinking: true })
    }

    this.recording.checkpoints.push({ after: this.recording.steps.length, label, visible })
  }

  async connect(): Promise<void> {
    this.connection += 1

    const connection = this.connection
    const socket = new WebSocket(`${this.gateway.wsUrl}?token=${TOKEN}`)

    this.socket = socket
    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (line.trim()) {
          this.onFrame(connection, JSON.parse(line) as Json)
        }
      }
    })

    await this.until(() =>
      this.recording.frames.some(entry => entry.connection === connection && (entry.frame as Json).params !== undefined)
    )
  }

  async disconnect(): Promise<void> {
    const socket = this.socket

    if (!socket) {
      return
    }

    this.socket = null
    await new Promise<void>(resolve => {
      socket.once('close', () => resolve())
      socket.close()
    })
  }

  async request<T = Json>(method: string, params: Json): Promise<T> {
    return (await this.call<T>(method, params)).result
  }

  /** A JSON-RPC call; resolves with the result and the index of its response frame. */
  call<T = Json>(method: string, params: Json): Promise<{ result: T; frame: number }> {
    const socket = this.socket

    if (!socket) {
      throw new Error(`${method}: not connected`)
    }

    this.requestSeq += 1

    const id = `c-${this.requestSeq}`

    return new Promise<{ result: T; frame: number }>((resolve, reject) => {
      this.pending.set(id, (frame, index) => {
        if (frame.error) {
          reject(new Error(`${method}: ${JSON.stringify(frame.error)}`))
        } else {
          resolve({ result: frame.result as T, frame: index })
        }
      })
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** Resolve once `predicate` holds, re-checked after every frame. */
  until(predicate: () => boolean, label = 'a condition'): Promise<void> {
    if (predicate()) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`Timed out waiting for ${label}`))
      }, TIMEOUT_MS)
      const check = () => {
        if (predicate()) {
          clearTimeout(timer)
          this.waiters.delete(check)
          resolve()
        }
      }

      this.waiters.add(check)
    })
  }

  /** How many frames of `type` this session has seen so far. */
  count(type: string): number {
    return this.recording.frames.filter(entry => {
      const params = (entry.frame as Json).params as Json | undefined

      return (entry.frame as Json).method === 'event' && params?.type === type
    }).length
  }

  private onFrame(connection: number, frame: Json): void {
    const index = this.recording.frames.length

    this.recording.frames.push({ connection, frame })

    if (typeof frame.method !== 'string') {
      const id = String(frame.id)
      const settle = this.pending.get(id)

      this.pending.delete(id)
      settle?.(frame, index)
    } else if (frame.method === 'event') {
      const event = frame.params as TranscriptEvent & Json

      // Exactly the controller's filter: only this chat's runtime session.
      if (this.runtimeId && event.session_id === this.runtimeId) {
        const now = this.now()

        this.step('applyEvent', [event, now], state => applyEvent(state, event, now), index)
      }
    } else if (frame.id !== undefined) {
      this.onServerRequest(frame, index)
    }

    for (const waiter of [...this.waiters]) {
      waiter()
    }
  }

  private onServerRequest(frame: Json, index: number): void {
    const params = (frame.params ?? {}) as Json
    const method = String(frame.method)
    const id = String(frame.id)

    if ((method !== 'approval' && method !== 'clarify') || params.session_id !== this.runtimeId) {
      return
    }

    const request: ServerRequest = { id, method, params }
    const now = this.now()

    this.step('applyServerRequest', [request, now], state => applyServerRequest(state, request, now), index)

    let result: Json

    if (method === 'approval' && this.answers.approval) {
      const choice = this.answers.approval

      this.step('answerRequest', [id, choice], state => answerRequest(state, id, choice), index)
      result = { choice }
    } else if (method === 'clarify' && this.answers.clarify) {
      const answers = this.answers.clarify
      const batch = Array.isArray(params.questions)

      this.step('answerRequest', [id, answers], state => answerRequest(state, id, answers), index)
      result = batch ? { answers } : { answer: Object.values(answers)[0] ?? '' }
    } else {
      return
    }

    this.socket?.send(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  /** `patchState`: a shallow merge into the state, then the listed keys removed. */
  patch(fields: Json, remove: string[] = [], frame?: number): void {
    this.step(
      'patchState',
      remove.length ? [fields, remove] : [fields],
      state => {
        const next = { ...state, ...fields } as Json

        for (const key of remove) {
          delete next[key]
        }

        return next as unknown as ChatState
      },
      frame
    )
  }

  /** The store's `bindRuntime`: a different runtime session restarts the watermark. */
  private bindRuntime(runtimeId: string, frame: number): void {
    this.runtimeId = runtimeId

    if (this.state.lastSeqSessionId === runtimeId) {
      this.patch({ runtimeSessionId: runtimeId }, [], frame)
    } else {
      this.patch({ runtimeSessionId: runtimeId, lastSeq: 0, lastSeqSessionId: runtimeId }, ['epoch'], frame)
    }
  }

  private async resume(): Promise<{ resume: Json; frame: number }> {
    const { result: resume, frame } = await this.call<Json>('session.resume', {
      session_id: this.storedId,
      profile: this.profile,
      omit_messages: true,
      source: 'hermie',
      cols: 96
    })

    this.bindRuntime(String(resume.session_id), frame)

    return { resume, frame }
  }

  /** The controller's `resumeSnapshotOf`, applied. */
  private applySnapshot(resume: Json, frame: number): void {
    const info = resume.info as Json | undefined
    const record = (value: unknown) => (value && typeof value === 'object' ? { ...(value as Json) } : null)
    const snapshot = {
      inflight: record(resume.inflight),
      running: (resume.running as boolean | undefined) ?? null,
      turn_started_at: (resume.turn_started_at as number | undefined) ?? (info?.turn_started_at as number) ?? null,
      queued: record(resume.queued),
      pending_approval: record(resume.pending_approval),
      todo_state: record(resume.todo_state),
      open_requests: (resume.open_requests as Json[] | undefined) ?? null
    } as Parameters<typeof applyResumeSnapshot>[1]
    const now = this.now()

    this.step('applyResumeSnapshot', [snapshot, now], state => applyResumeSnapshot(state, snapshot, now), frame)
  }

  /** The controller's `registerOpenRequests`: re-delivered requests become cards again. */
  private registerOpenRequests(entries: unknown, frame: number): void {
    for (const entry of Array.isArray(entries) ? (entries as Json[]) : []) {
      if (typeof entry?.id !== 'string' || typeof entry.method !== 'string') {
        continue
      }

      const request: ServerRequest = {
        id: entry.id,
        method: entry.method,
        params: entry.params && typeof entry.params === 'object' ? (entry.params as Json) : {},
        replayed: true
      }
      const now = this.now()

      this.step('applyServerRequest', [request, now], state => applyServerRequest(state, request, now), frame)
    }
  }

  /**
   * The controller's `replaySince`. Cold (no watermark yet, or another epoch):
   * adopt `latest_seq` without replaying, history already has it. Warm: apply
   * every event the ring returns.
   */
  private async replaySince(): Promise<void> {
    const knownEpoch = this.state.epoch
    const { result: since, frame } = await this.call<{
      events?: Json[]
      latest_seq: number
      epoch: string
      truncated?: boolean
      open_requests?: Json[]
    }>('session.events.since', { session_id: this.runtimeId, last_seen: this.state.lastSeq })
    const epochChanged = knownEpoch !== undefined && knownEpoch !== since.epoch
    const cold = this.state.lastSeq === 0 || epochChanged

    if (cold || since.truncated) {
      this.patch(
        {
          lastSeq: epochChanged ? since.latest_seq : Math.max(this.state.lastSeq, since.latest_seq),
          lastSeqSessionId: this.runtimeId,
          epoch: since.epoch
        },
        [],
        frame
      )
    } else {
      for (const raw of since.events ?? []) {
        if (typeof raw.type !== 'string') {
          continue
        }

        // The controller's `transcriptEventOf`.
        const event = {
          type: raw.type,
          ...(typeof raw.session_id === 'string' ? { session_id: raw.session_id } : {}),
          ...(typeof raw.seq === 'number' ? { seq: raw.seq } : {}),
          payload: raw.payload
        } as TranscriptEvent
        const now = this.now()

        this.step('applyEvent', [event, now], state => applyEvent(state, event, now), frame)
      }

      if (this.state.epoch !== since.epoch) {
        this.patch({ epoch: since.epoch }, [], frame)
      }
    }

    this.registerOpenRequests(since.open_requests, frame)
  }

  private async canonical(): Promise<Json> {
    const roster = await this.request<{ profiles?: Json[] }>('profiles.list', { include_sessions: true })
    const canonical = (roster.profiles ?? []).find(entry => entry.name === this.profile)?.canonical_session as
      Json | undefined

    if (!canonical) {
      throw new Error(`${this.profile} has no canonical Bot Chat`)
    }

    return canonical
  }

  /**
   * The controller's `hydrate`: roster, resume on the durable id, the resume's
   * own `session.info`, history, the resume snapshot, open requests, replay.
   */
  async hydrate(): Promise<void> {
    const canonical = await this.canonical()

    this.storedId = String(canonical.id)
    this.resolvedId = String(canonical.resolved_id || canonical.id)

    const { storedId, profile } = this
    const resolvedId = this.resolvedId

    this.step('createChatState', [profile, storedId, resolvedId], () => createChatState(profile, storedId, resolvedId))

    const { resume, frame: resumeFrame } = await this.resume()

    if (resume.info) {
      const event = { type: 'session.info', session_id: this.runtimeId, payload: resume.info } as TranscriptEvent
      const now = this.now()

      this.step('applyEvent', [event, now], state => applyEvent(state, event, now), resumeFrame)
    }

    const { result: history, frame: historyFrame } = await this.call<{ messages?: TranscriptRow[] }>(
      'session.history',
      { session_id: this.runtimeId, profile: this.profile }
    )
    const rows = history.messages ?? []

    if (rows.length) {
      const items = rowsToItems(rows, 'rpc')

      this.step('reconcile', [items], state => reconcile(state, items), historyFrame)
    }

    this.applySnapshot(resume, resumeFrame)
    this.registerOpenRequests(resume.open_requests, resumeFrame)
    await this.replaySince()
  }

  /**
   * The controller's `recoverAfterReconnect`: re-resume, snapshot, open
   * requests, replay, and, when the roster counts more rows than the chat
   * holds, the REST tail.
   */
  async recover(): Promise<void> {
    const canonical = await this.canonical()
    const { resume, frame } = await this.resume()

    this.applySnapshot(resume, frame)
    this.registerOpenRequests(resume.open_requests, frame)
    await this.replaySince()

    const expected = typeof canonical.message_count === 'number' ? canonical.message_count : 0
    const persisted = this.state.order.filter(id => this.state.items[id]?.rowId !== undefined).length

    if (expected > persisted) {
      const response = await fetch(
        `${this.gateway.url}/api/sessions/${encodeURIComponent(this.resolvedId)}/messages?limit=${TAIL_ROW_LIMIT}&order=latest`,
        { headers: { 'X-Hermes-Session-Token': TOKEN } }
      )
      const body = (await response.json()) as { messages?: TranscriptRow[] }
      const index = this.recording.frames.length

      this.recording.frames.push({ connection: 'rest', frame: body })

      const rows = body.messages ?? []

      if (rows.length) {
        const items = rowsToItems(rows, 'rest')

        this.step('reconcileTail', [items], state => reconcileTail(state, items), index)
      }
    }
  }

  /** Paint, submit and confirm a turn, in the order the controller's `send` does. */
  async submit(text: string): Promise<void> {
    const beginNow = this.now()

    this.step('beginLocalTurn', [text, null, beginNow], state => beginLocalTurn(state, text, undefined, beginNow))

    const { result, frame } = await this.call<{ status?: string }>('prompt.submit', {
      session_id: this.runtimeId,
      profile: this.profile,
      text
    })
    const submitResult = { status: result?.status ?? null }
    const confirmNow = this.now()

    this.step(
      'confirmSubmit',
      [submitResult, confirmNow],
      state => confirmSubmit(state, submitResult, confirmNow),
      frame
    )
  }

  /** The end of a turn: its `message.complete`, then the roster nudge that follows it. */
  async settle(completesBefore: number): Promise<void> {
    await this.until(() => this.count('message.complete') > completesBefore, 'message.complete')
    await this.until(() => {
      const last = this.recording.frames[this.recording.frames.length - 1]?.frame as Json | undefined

      return ((last?.params as Json | undefined)?.type as string | undefined) === 'sessions.changed'
    }, 'sessions.changed')
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────

interface Scenario {
  name: string
  description: string
  profile: string
  answers?: { approval?: string; clarify?: Record<string, string> }
  run: (client: Client, gateway: FakeGateway) => Promise<void>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'plain-turn',
    description: 'Open the chat, send a prompt and stream a plain reply (the "math" scenario: no tool call).',
    profile: 'researcher',
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('explain the math behind the retry budget')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'tool-turn',
    description: 'A reply that reasons first, generates and runs one tool call, then answers.',
    profile: 'researcher',
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('summarise the notes')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'approval',
    description: 'The turn parks on a server→client approval; the client answers "once" and the turn completes.',
    profile: 'researcher',
    answers: { approval: 'once' },
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('please approve this cleanup')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'clarify',
    description: 'An idle chat receives a two-question batch clarify; the client answers both by qid.',
    profile: 'researcher',
    answers: { clarify: { q1: 'staging', q2: 'yes' } },
    async run(client, gateway) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const answered = gateway.requestServerSide('clarify', {
        session_id: client.runtimeId,
        questions: [
          { qid: 'q1', question: 'Which environment?', choices: ['staging', 'production'], multi_select: false },
          { qid: 'q2', question: 'Notify the team?', choices: ['yes', 'no'], multi_select: false }
        ]
      })

      await answered
      client.checkpoint('answered')
    }
  },
  {
    name: 'subagents',
    description: 'A delegate_task fan-out of three subagents, the third of which fails, inside one turn.',
    profile: 'researcher',
    async run(client) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('delegate the release checks')
      await client.settle(before)
      client.checkpoint('settled')
    }
  },
  {
    name: 'reconnect-replay',
    description:
      'Stream a turn live, disconnect while idle, let a second device run a turn on the same session, then ' +
      'reconnect the way the controller recovers: re-resume, replay the missed events through ' +
      'session.events.since, and fold in the REST tail because the roster counts more rows than the chat holds.',
    profile: 'researcher',
    async run(client, gateway) {
      await client.hydrate()
      client.checkpoint('hydrated')

      const before = client.count('message.complete')

      await client.submit('summarise the notes')
      await client.settle(before)
      client.checkpoint('settled live')

      await client.disconnect()

      // Another device on the same session; nothing it receives is recorded.
      const other = new Client(gateway, client.profile)

      await other.connect()
      await other.hydrate()

      const otherBefore = other.count('message.complete')

      await other.submit('explain the math behind the retry budget')
      await other.settle(otherBefore)
      await other.disconnect()

      await client.connect()
      await client.recover()
      client.checkpoint('recovered')
    }
  }
]

function outDir(): string {
  const index = process.argv.indexOf('--out')
  const dir = index >= 0 ? process.argv[index + 1] : undefined

  if (!dir) {
    console.error('usage: dump-frames.ts --out <dir>')
    process.exit(1)
  }

  return dir
}

async function record(scenario: Scenario): Promise<unknown> {
  uuidCounter = 0

  const gateway = await startFakeGateway({ auth: 'token', token: TOKEN, streamDelayMs: 4, subagentStepMs: 4 })

  try {
    const client = new Client(gateway, scenario.profile, scenario.answers)

    await client.connect()
    await scenario.run(client, gateway)
    await client.disconnect()

    return {
      scenario: scenario.name,
      description: scenario.description,
      profile: scenario.profile,
      pinnedNow: PINNED_NOW,
      stepMs: STEP_MS,
      frames: client.recording.frames,
      steps: client.recording.steps,
      checkpoints: client.recording.checkpoints,
      final: client.state
    }
  } finally {
    await gateway.close()
  }
}

const dir = join(outDir(), 'transcript', 'streams')

mkdirSync(dir, { recursive: true })

for (const scenario of SCENARIOS) {
  writeFileSync(join(dir, `${scenario.name}.json`), prettyJson(await record(scenario)))
}
