/**
 * Records every top-level call a test makes into the engine's public API.
 *
 * Only loaded by `vitest.golden.config.ts`; `npm test` never imports it. The
 * plugin in `plugin.ts` hands each test file wrapped copies of the engine's
 * exports, and every wrapper ends up here.
 *
 * A call is written down only when it is replayable, and that is checked, not
 * assumed: its arguments are encoded to canonical JSON, decoded again, and the
 * real function is run a second time on the decoded copy. Only when that second
 * run yields the same canonical result (or throws again) does the call enter
 * the corpus. Everything else is counted per operation and reason, so the
 * README can say exactly what a port does not get to replay.
 */
import { expect } from 'vitest'

import { canonical, type Json, NotJsonError, toJson } from '../../../scripts/golden/canonical-json'

/** The instant every engine call in the corpus sees: 2026-09-21T14:13:20Z. */
export const PINNED_NOW = 1_790_000_000_000

export interface RecordedCall {
  op: string
  args: Json[]
  result?: Json
  throws?: true
  /** Present only when the call read the clock itself (no `now` parameter to put it in). */
  now?: number
}

export interface TestGroup {
  test: string
  calls: RecordedCall[]
}

export interface OpStats {
  recorded: number
  replayable: number
  skipped: Record<string, number>
  readsClock: boolean
}

const groups: TestGroup[] = []
const stats: Record<string, OpStats> = {}
let depth = 0
let clockReads = 0

/** Called by the pinned `Date` whenever anything asks it for the time. */
export function noteClockRead(): void {
  clockReads += 1
}

export function recordedGroups(): TestGroup[] {
  return groups
}

export function recordedStats(): Record<string, OpStats> {
  return stats
}

function statsFor(op: string): OpStats {
  stats[op] ??= { recorded: 0, replayable: 0, skipped: {}, readsClock: false }

  return stats[op]
}

function skip(op: string, reason: string): void {
  const entry = statsFor(op)

  entry.skipped[reason] = (entry.skipped[reason] ?? 0) + 1
}

/**
 * Positional arguments as JSON. A trailing `undefined` is dropped; one in the
 * middle (an optional parameter skipped to reach a later one) is written as
 * `null`, which the replay protocol reads as "not supplied".
 */
function encodeArgs(args: unknown[]): Json[] {
  let end = args.length

  while (end > 0 && args[end - 1] === undefined) {
    end -= 1
  }

  return args.slice(0, end).map((arg, index) => toJson(arg, `args[${index}]`) ?? null)
}

/** The replay protocol's reading of an argument list: a top-level `null` is "not supplied". */
export function decodeArgs(args: Json[]): unknown[] {
  return args.map(arg => (arg === null ? undefined : structuredClone(arg)))
}

type Outcome = { threw: false; value: unknown } | { threw: true; error: unknown }

function run(fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]): Outcome {
  try {
    return { threw: false, value: fn.apply(self, args) }
  } catch (error) {
    return { threw: true, error }
  }
}

function currentTestName(): string {
  return expect.getState().currentTestName ?? '(module scope)'
}

function push(call: RecordedCall): void {
  const test = currentTestName()
  const last = groups[groups.length - 1]

  if (last && last.test === test) {
    last.calls.push(call)
  } else {
    groups.push({ test, calls: [call] })
  }
}

/**
 * Wrap one exported engine function.
 *
 * `nowIndex` is the position of its `now` parameter, if it has one. When the
 * caller left it out, the wrapper supplies the pinned clock explicitly — the
 * value the default would have produced — so the recorded call carries it.
 */
export function wrapFunction<F extends (...args: never[]) => unknown>(op: string, fn: F, nowIndex?: number): F {
  const wrapped = function (this: unknown, ...callArgs: unknown[]): unknown {
    if (depth > 0) {
      return (fn as unknown as (...args: unknown[]) => unknown).apply(this, callArgs)
    }

    const args = [...callArgs]

    if (nowIndex !== undefined && args[nowIndex] === undefined) {
      while (args.length < nowIndex) {
        args.push(undefined)
      }

      args[nowIndex] = Date.now()
    }

    let encodedArgs: Json[] | undefined
    let argsProblem: string | undefined

    try {
      encodedArgs = encodeArgs(args)
    } catch (error) {
      if (!(error instanceof NotJsonError)) {
        throw error
      }

      argsProblem = `args: ${error.reason}`
    }

    const real = fn as unknown as (...args: unknown[]) => unknown
    const readsBefore = clockReads

    depth += 1

    let outcome: Outcome

    try {
      outcome = run(real, this, args)
    } finally {
      depth -= 1
    }

    const readClock = clockReads !== readsBefore
    const entry = statsFor(op)

    entry.recorded += 1

    if (readClock) {
      entry.readsClock = true
    }

    // Hand the caller exactly what it would have had without the recorder.
    const handBack = (): unknown => {
      if (outcome.threw) {
        throw outcome.error
      }

      return outcome.value
    }

    if (argsProblem || !encodedArgs) {
      skip(op, argsProblem ?? 'args: unknown')

      return handBack()
    }

    let encodedResult: Json | undefined

    if (!outcome.threw) {
      try {
        encodedResult = toJson(outcome.value, 'result')
      } catch (error) {
        if (!(error instanceof NotJsonError)) {
          throw error
        }

        skip(op, `result: ${error.reason}`)

        return handBack()
      }
    }

    // The proof: run it again from the JSON alone.
    depth += 1

    let replay: Outcome

    try {
      replay = run(real, this, decodeArgs(encodedArgs))
    } finally {
      depth -= 1
    }

    let same: boolean

    if (outcome.threw || replay.threw) {
      same = outcome.threw && replay.threw
    } else {
      try {
        same = canonical(replay.value) === canonical(outcome.value)
      } catch {
        same = false
      }
    }

    if (!same) {
      skip(op, 'replay differs after a JSON round trip')

      return handBack()
    }

    entry.replayable += 1

    const call: RecordedCall = { op, args: encodedArgs }

    if (outcome.threw) {
      call.throws = true
    } else if (encodedResult !== undefined) {
      call.result = encodedResult
    }

    if (readClock && nowIndex === undefined) {
      call.now = PINNED_NOW
    }

    push(call)

    return handBack()
  }

  Object.defineProperty(wrapped, 'name', { value: op })

  return wrapped as unknown as F
}

/** The generated wrapper modules call this for every runtime export. */
export function wrapExport<T>(op: string, value: T, kind: 'function' | 'class' | 'value', nowIndex?: number): T {
  if (typeof value !== 'function' || kind === 'class') {
    return value
  }

  return wrapFunction(op, value as unknown as (...args: never[]) => unknown, nowIndex) as unknown as T
}
