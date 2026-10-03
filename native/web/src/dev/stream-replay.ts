/**
 * Replays a recorded stream scenario (`contract/transcript/streams/*.json`)
 * through the engine, one step at a time, the way the Swift port's golden
 * runner does (`GoldenStreamRunner` in `native/apple/HermieKit`).
 *
 * Development only: the transcript harness and its tests use it. Each step names
 * an engine function and its arguments after the state; two steps are not engine
 * functions: `createChatState` starts a state, and `patchState` is the
 * controller's own shallow merge (fields in, then the listed keys removed).
 */
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
  type TranscriptItem,
  type VisibleItem
} from '@hermie/transcript'

export interface StreamStep {
  op: string
  args: unknown[]
  frame?: number
}

export interface StreamCheckpoint {
  /** The number of steps applied before this checkpoint. */
  after: number
  label: string
  visible: Record<string, VisibleItem[]>
}

export interface StreamScenario {
  scenario: string
  description: string
  steps: StreamStep[]
  checkpoints: StreamCheckpoint[]
}

type Op = (state: ChatState, ...args: never[]) => ChatState

const ENGINE: Record<string, Op> = {
  answerRequest,
  applyEvent,
  applyResumeSnapshot,
  applyServerRequest,
  beginLocalTurn,
  confirmSubmit,
  reconcile,
  reconcileTail
}

export function patchState(state: ChatState, fields?: Partial<ChatState>, remove?: readonly string[]): ChatState {
  const next: Record<string, unknown> = { ...state, ...fields }
  for (const key of remove ?? []) {
    delete next[key]
  }
  return next as unknown as ChatState
}

export interface ReplayOptions {
  /**
   * Items put in front of the first history the scenario hydrates with, so a
   * scenario plays out at the end of a long chat. Their ids must not collide
   * with the scenario's.
   */
  history?: readonly TranscriptItem[]
}

/** Applies one step. `state` is undefined only before `createChatState`. */
export function applyStep(state: ChatState | undefined, step: StreamStep, options: ReplayOptions = {}): ChatState {
  if (step.op === 'createChatState') {
    const [bot, stored, resolved] = step.args as [string, string, string]
    return createChatState(bot, stored, resolved)
  }

  if (!state) {
    throw new Error(`stream step ${step.op} before createChatState`)
  }

  if (step.op === 'patchState') {
    return patchState(state, step.args[0] as Partial<ChatState>, step.args[1] as string[] | undefined)
  }

  const op = ENGINE[step.op]
  if (!op) {
    throw new Error(`stream step ${step.op} is not an engine operation`)
  }

  let args = step.args
  if (step.op === 'reconcile' && options.history?.length && state.order.length === 0) {
    args = [[...options.history, ...(args[0] as TranscriptItem[])], ...args.slice(1)]
  }

  return (op as (state: ChatState, ...rest: unknown[]) => ChatState)(state, ...args)
}

/** Every state the scenario passes through, the first one after its first step. */
export function* replay(scenario: StreamScenario, options: ReplayOptions = {}): Generator<ChatState> {
  let state: ChatState | undefined
  for (const step of scenario.steps) {
    state = applyStep(state, step, options)
    yield state
  }
}
