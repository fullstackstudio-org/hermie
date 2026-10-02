/**
 * Re-records the expected results of the Swift engine's hand-written branch
 * cases from the TypeScript engine, or checks that they are current.
 *
 *   npm run golden:branch-cases          # rewrite the expectations in place
 *   npm run golden:branch-cases:check    # fail if any expectation is stale
 *
 * The golden corpus (`npm run golden`) is recorded from the TypeScript tests, so
 * it only holds the calls those tests happen to make. The branches it never
 * reaches are covered on the Swift side by two hand-written files whose inputs
 * live next to the result the TypeScript engine gives for them:
 *
 *   native/apple/HermieKit/Tests/HermieTranscriptTests/HistoryBranchCases.swift
 *     One golden call per line, `{"args","name","op","result"}`. `result` is
 *     `op(...args)`, with a top-level `null` argument read as "not supplied", as
 *     the replay protocol reads it (`contract/README.md`).
 *
 *   native/apple/HermieKit/Tests/HermieTranscriptTests/ReducerBranchTests.swift
 *     Scenarios `{"name","covers","steps","expected"}` in the `fixture` literal.
 *     Each starts from `createChatState('bot', 'stored', 'resolved')` and runs
 *     its steps in order: `[op, ...args]` calls `op(state, ...args)`, and
 *     `["patchState", fields, remove]` is `{ ...state, ...fields }` without the
 *     keys in `remove`. `expected` is the final state.
 *
 * Only the expectations are rewritten; names, inputs, comments and layout stay
 * as they are, so adding a case is writing its inputs with any placeholder
 * result (`null` will do) and running this. Every expectation is written as
 * canonical JSON on its own line, as the files already hold them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as engine from '../../packages/transcript/src/index'
import { compareKeys, type Json, toJson } from './canonical-json'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const testsDir = join(repoRoot, 'native/apple/HermieKit/Tests/HermieTranscriptTests')
const check = process.argv.includes('--check')

type EngineFunction = (...args: unknown[]) => unknown

function operation(op: string): EngineFunction {
  const fn = (engine as Record<string, unknown>)[op]

  if (typeof fn !== 'function') {
    throw new Error(`@hermie/transcript exports no function named ${op}`)
  }

  return fn as EngineFunction
}

/**
 * The canonical text of a value, keys in UTF-16 code unit order at every depth.
 *
 * Written out rather than `canonical()`: `JSON.stringify` enumerates an
 * object's integer-like keys first and in numeric order (`"5"` before `"10"`),
 * whatever order they were inserted in, and the files keep the order the
 * contract states (`"10"` before `"5"`). Both orders parse to the same value.
 */
function canonicalText(value: unknown): string {
  const write = (json: Json): string => {
    if (json === null || typeof json !== 'object') {
      return JSON.stringify(json)
    }

    if (Array.isArray(json)) {
      return `[${json.map(write).join(',')}]`
    }

    const keys = Object.keys(json).sort(compareKeys)

    return `{${keys.map(key => `${JSON.stringify(key)}:${write(json[key]!)}`).join(',')}}`
  }

  return write(toJson(value) ?? null)
}

/** The replay protocol's reading of an argument list: a top-level `null` is "not supplied". */
function decodeArgs(args: Json[]): unknown[] {
  return args.map(arg => (arg === null ? undefined : structuredClone(arg)))
}

/** The JSON between the opening and closing delimiters of a Swift raw string literal. */
function literal(source: string, open: string, close: string, file: string): { start: number; end: number } {
  const at = source.indexOf(open)
  const end = source.lastIndexOf(close)

  if (at < 0 || end < at) {
    throw new Error(`${file}: no ${open} … ${close} literal`)
  }

  return { start: at + open.length, end }
}

function historyCases(source: string, file: string): string {
  const { start, end } = literal(source, 'static let json = ##"""\n', '\n"""##', file)
  const lines = source.slice(start, end).split('\n')

  const rewritten = lines.map(line => {
    if (!line.startsWith('{')) {
      return line
    }

    const comma = line.endsWith(',') ? ',' : ''
    const call = JSON.parse(comma ? line.slice(0, -1) : line) as { args: Json[]; name: string; op: string }
    const result = operation(call.op)(...decodeArgs(call.args))

    return canonicalText({ args: call.args, name: call.name, op: call.op, result }) + comma
  })

  return source.slice(0, start) + rewritten.join('\n') + source.slice(end)
}

function reducerScenarios(source: string, file: string): string {
  const { start, end } = literal(source, 'private let fixture = #"""\n', '\n"""#', file)
  const body = source.slice(start, end)
  const scenarios = JSON.parse(body) as { name: string; steps: [string, ...Json[]][] }[]

  const expected = scenarios.map(scenario => {
    let state: unknown = engine.createChatState('bot', 'stored', 'resolved')

    for (const [op, ...args] of scenario.steps) {
      if (op === 'patchState') {
        const [fields, remove] = args as [Record<string, Json> | null, string[] | null]
        const patched: Record<string, unknown> = { ...(state as Record<string, unknown>), ...fields }

        for (const key of remove ?? []) {
          delete patched[key]
        }

        state = patched
        continue
      }

      state = operation(op)(state, ...decodeArgs(args))
    }

    return canonicalText(state)
  })

  const lines = body.split('\n')
  const expectedLines = lines.flatMap((line, index) => (line.startsWith('    "expected": ') ? [index] : []))

  if (expectedLines.length !== scenarios.length) {
    throw new Error(`${file}: ${scenarios.length} scenarios but ${expectedLines.length} "expected" lines`)
  }

  expectedLines.forEach((index, scenario) => {
    lines[index] = `    "expected": ${expected[scenario]}`
  })

  return source.slice(0, start) + lines.join('\n') + source.slice(end)
}

const targets: [string, (source: string, file: string) => string][] = [
  ['HistoryBranchCases.swift', historyCases],
  ['ReducerBranchTests.swift', reducerScenarios]
]

let stale = 0

for (const [name, rewrite] of targets) {
  const path = join(testsDir, name)
  const source = readFileSync(path, 'utf8')
  const next = rewrite(source, name)

  if (next === source) {
    console.log(`${name}: current`)
  } else if (check) {
    console.error(`${name}: stale; run npm run golden:branch-cases`)
    stale += 1
  } else {
    writeFileSync(path, next)
    console.log(`${name}: rewritten`)
  }
}

if (stale > 0) {
  process.exit(1)
}
