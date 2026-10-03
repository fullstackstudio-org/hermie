/**
 * A long chat and a live reply, made up but shaped like the real thing, for the
 * transcript harness. Development only.
 *
 * The history is persisted rows, projected by the engine's own `rowsToItems`
 * and hydrated with `reconcile`, so it is exactly what a chat loaded from the
 * gateway holds: human turns, replies of very different lengths (some with a
 * thought), tool calls. The live reply is gateway events through `applyEvent`.
 * Both are deterministic for a seed, so two runs measure the same work.
 */
import {
  applyEvent,
  beginLocalTurn,
  type ChatState,
  confirmSubmit,
  createChatState,
  reconcile,
  rowsToItems,
  type TranscriptItem,
  type TranscriptRow
} from '@hermie/transcript'

import { patchState } from './stream-replay'

export const SYNTHETIC_BOT = 'tester'
const SESSION = 'runtime-synthetic'

/** A small, fast, seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the gateway answered with a status and the reply streamed in small pieces while the reader ' +
  'kept scrolling through older messages looking for the table that explained the retry budget ' +
  'per attempt instead of per call so a long request no longer inherits the delay of the previous one'
).split(' ')

function sentence(random: () => number, words: number): string {
  const out: string[] = []
  for (let index = 0; index < words; index += 1) {
    out.push(WORDS[Math.floor(random() * WORDS.length)] as string)
  }
  const text = out.join(' ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

function paragraphs(random: () => number, count: number): string {
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => sentence(random, 6 + Math.floor(random() * 14))).join(
      ' '
    )
  ).join('\n\n')
}

/**
 * Persisted rows for a chat of about `items` items (the engine may merge or
 * split a few). Row ids count up from `firstRowId`: the engine orders persisted
 * rows by id, so the default is below zero, in front of the recorded scenarios'
 * own rows (numbered from 1), and a page of older history takes a lower start.
 */
export function syntheticRows(items: number, seed = 1, firstRowId = -1_000_000): TranscriptRow[] {
  const random = seeded(seed)
  const rows: TranscriptRow[] = []
  let rowId = firstRowId
  let ts = 1_700_000_000

  while (rows.length < items) {
    ts += 60
    rows.push({ role: 'user', text: sentence(random, 4 + Math.floor(random() * 18)), row_id: rowId++, timestamp: ts })

    const tools = random() < 0.35 ? 1 + Math.floor(random() * 2) : 0
    for (let index = 0; index < tools && rows.length < items; index += 1) {
      const path = `notes/${rowId}.md`
      rows.push({
        role: 'tool',
        name: 'read_file',
        tool_id: `call_${rowId}`,
        context: `read_file(${path})`,
        args: { path },
        row_id: rowId++,
        timestamp: ts
      })
    }

    if (rows.length < items) {
      const length = random()
      const count = length < 0.5 ? 1 : length < 0.85 ? 2 + Math.floor(random() * 2) : 4 + Math.floor(random() * 5)
      rows.push({
        role: 'assistant',
        text: paragraphs(random, count),
        reasoning: random() < 0.2 ? sentence(random, 8) : null,
        row_id: rowId++,
        timestamp: ts + 5
      })
    }
  }

  return rows
}

export function syntheticItems(items: number, seed = 1, firstRowId = -1_000_000): TranscriptItem[] {
  return rowsToItems(syntheticRows(items, seed, firstRowId), 'rest')
}

/** A chat hydrated with `items` synthetic history items, ready for live events. */
export function syntheticChat(items: number, seed = 1): ChatState {
  const empty = patchState(createChatState(SYNTHETIC_BOT, 'stored-synthetic', 'stored-synthetic'), {
    runtimeSessionId: SESSION,
    lastSeq: 0,
    lastSeqSessionId: SESSION
  })
  return reconcile(empty, syntheticItems(items, seed))
}

/**
 * A live conversation on top of a chat, one engine call per `tick`: each turn
 * is a prompt, a tool call, and a reply streamed in deltas taken from `texts`
 * (the recorded streams' own deltas), `deltasPerTurn` of them.
 */
export class LiveConversation {
  private seq: number
  private tick = 0
  private turn = 0
  private text = 0
  private readonly random: () => number

  constructor(
    private readonly texts: readonly string[],
    private readonly deltasPerTurn = 300,
    start: ChatState,
    seed = 7
  ) {
    this.seq = start.lastSeq
    this.random = seeded(seed)
  }

  /** The number of `message.delta` events applied so far. */
  deltas = 0

  private event(type: string, payload: Record<string, unknown>) {
    this.seq += 1
    return { type, payload, seq: this.seq, session_id: SESSION }
  }

  /** Applies the next step of the conversation. */
  step(state: ChatState, now: number): ChatState {
    const phase = this.tick % (this.deltasPerTurn + 4)
    this.tick += 1
    const toolId = `live_tool_${this.turn}`

    switch (phase) {
      case 0:
        return confirmSubmit(
          beginLocalTurn(state, sentence(this.random, 6 + Math.floor(this.random() * 10)), undefined, now),
          { status: 'streaming' },
          now
        )
      case 1:
        return applyEvent(state, this.event('message.start', {}), now)
      case 2:
        return applyEvent(
          state,
          this.event('tool.start', { tool_id: toolId, name: 'read_file', args: { path: 'README.md' } }),
          now
        )
      case 3:
        return applyEvent(
          state,
          this.event('tool.complete', { tool_id: toolId, name: 'read_file', result: 'ok', summary: 'read README.md' }),
          now
        )
      case this.deltasPerTurn + 3: {
        this.turn += 1
        return applyEvent(state, this.event('message.complete', { status: 'ok' }), now)
      }
      default: {
        const text = this.texts[this.text % this.texts.length] as string
        this.text += 1
        this.deltas += 1
        return applyEvent(state, this.event('message.delta', { text }), now)
      }
    }
  }
}

/** The text of every `message.delta` in the recorded scenarios, in order. */
export function deltaTexts(scenarios: readonly { steps: readonly { op: string; args: unknown[] }[] }[]): string[] {
  const texts: string[] = []
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      const event = step.args[0] as { type?: string; payload?: { text?: unknown } } | undefined
      if (step.op === 'applyEvent' && event?.type === 'message.delta' && typeof event.payload?.text === 'string') {
        texts.push(event.payload.text)
      }
    }
  }
  return texts
}
