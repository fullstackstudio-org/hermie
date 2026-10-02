/**
 * A Mermaid `sequenceDiagram` → a script of steps, or `null`.
 *
 * ## The subset, stated up front
 *
 * Participants and actors, the seven arrow spellings a model actually writes,
 * messages with text, the three note placements, and `loop` / `alt` / `else` /
 * `opt` / `par` / `and` frames closed by `end`. Activation is read from the
 * `+` and `-` suffixes on an arrow and drawn as a bar on the lifeline.
 *
 * Everything else answers `null`, and `null` means the caller shows the fenced
 * source: `autonumber`, `activate` / `deactivate` as statements of their own,
 * `box`, `rect`, `critical`, `break`, `link` and the participant-creation
 * statements. That is deliberate rather than lazy — ignoring `autonumber` would
 * draw a diagram whose messages are not numbered although the author asked for
 * numbers, and ADR-0020's rule is that a picture which quietly leaves out what
 * was asked for is worse than the source it was made from.
 *
 * ## Pure, and total
 *
 * No React, no theme, no platform, and it never throws. A half-arrived diagram —
 * an `alt` whose `end` has not streamed yet, an arrow with no target — is a
 * `null` and a fenced listing, not an exception. That case is not exotic: it is
 * what every flush of a streaming reply carries.
 */

import { cleanLabel } from './labels'

/**
 * What the far end of an arrow carries.
 *
 * `none` is a line with nothing on it, which is what `--` alone means. The
 * dashes are a separate axis: any spelling that starts with `--` is drawn
 * dashed, exactly as Mermaid draws it.
 */
export type SequenceHead = 'filled' | 'open' | 'cross' | 'none'

export interface SequenceParticipant {
  id: string
  label: string
  /**
   * Declared with `actor` rather than `participant`.
   *
   * Mermaid draws a stick figure for one and a box for the other. This renderer
   * draws a box either way and marks the actor's, because a stick figure at a
   * diagram's own font size is four strokes nobody can read — and the
   * distinction the author drew is still visible.
   */
  actor: boolean
}

export interface SequenceMessage {
  kind: 'message'
  from: string
  to: string
  head: SequenceHead
  dashed: boolean
  text: string
  /** `+` after the arrow: this message activates its DESTINATION. */
  activates: boolean
  /** `-` after the arrow: this message deactivates its ORIGIN. */
  deactivates: boolean
}

export interface SequenceNote {
  kind: 'note'
  placement: 'over' | 'left' | 'right'
  /** The first participant the note is placed against. */
  from: string
  /** The last one it spans; the same as `from` for a note over one column. */
  to: string
  text: string
}

/** The frame words this parser draws a labelled box for. */
export type SequenceFrameWord = 'loop' | 'alt' | 'opt' | 'par'

export interface SequenceBranch {
  label: string
  steps: SequenceStep[]
}

export interface SequenceFrame {
  kind: 'frame'
  word: SequenceFrameWord
  /**
   * The frame's own label first, then one entry per `else` or `and`.
   *
   * One shape for both, because an `alt` with no `else` and a `loop` are the
   * same drawing — a box with a tag and one region — and a renderer that had to
   * special-case the head branch would have two ways to be wrong about it.
   */
  branches: SequenceBranch[]
}

export type SequenceStep = SequenceMessage | SequenceNote | SequenceFrame

export interface SequenceDiagram {
  participants: SequenceParticipant[]
  steps: SequenceStep[]
}

/** Past these a diagram is a transcript rather than a picture, and is left as source. */
const MAX_PARTICIPANTS = 12
const MAX_STEPS = 80
const MAX_DEPTH = 5
const MAX_SOURCE = 8000

const HEADER_RE = /^sequenceDiagram\s*$/iu

/** An identifier, the same shape the flowchart parser accepts. */
const ID = '[A-Za-z0-9_][A-Za-z0-9_.-]*'

const PARTICIPANT_RE = new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`, 'iu')
const NOTE_RE = /^note\s+(over|left\s+of|right\s+of)\s+([^:]+?)\s*:\s*(.*)$/iu
const FRAME_RE = /^(loop|alt|opt|par)\b\s*(.*)$/iu
const BRANCH_RE = /^(else|and)\b\s*(.*)$/iu
const END_RE = /^end$/iu

interface ArrowSpelling {
  token: string
  head: SequenceHead
  dashed: boolean
}

/**
 * The arrow spellings, longest first.
 *
 * Order is the whole correctness argument, exactly as it is for the flowchart's
 * edges: `-->>` has to be tried before `-->`, and `--` last of all, or the
 * shorter token wins and the rest of the arrow is read as part of a name.
 *
 * `-)` and `--)` are Mermaid's asynchronous arrows and are drawn with the same
 * open head as `->`, because the difference between an open arrow and a
 * half-open one is one stroke at this size and the reader cannot see it.
 */
const ARROWS: readonly ArrowSpelling[] = [
  { dashed: true, head: 'filled', token: '-->>' },
  { dashed: true, head: 'cross', token: '--x' },
  { dashed: true, head: 'open', token: '--)' },
  { dashed: true, head: 'open', token: '-->' },
  { dashed: false, head: 'filled', token: '->>' },
  { dashed: false, head: 'cross', token: '-x' },
  { dashed: false, head: 'open', token: '-)' },
  { dashed: false, head: 'open', token: '->' },
  { dashed: true, head: 'none', token: '--' }
]

/** One compiled matcher per spelling, built once rather than per line. */
const MESSAGE_PATTERNS: readonly { arrow: ArrowSpelling; re: RegExp }[] = ARROWS.map(arrow => ({
  arrow,
  // `)` is the only character in a spelling that means something to a regular
  // expression. A dash must NOT be escaped: `\-` outside a character class is a
  // syntax error under the `u` flag rather than a literal dash.
  re: new RegExp(`^(${ID})\\s*${arrow.token.replace(/\)/gu, '\\)')}\\s*([+-]?)\\s*(${ID})\\s*:\\s*(.*)$`, 'u')
}))

/** A whole name and nothing else, for the comma-separated list a note takes. */
const WHOLE_ID_RE = new RegExp(`^${ID}$`, 'u')

/**
 * The participant table, built in the order the source first mentions a column.
 *
 * Mention order is the column order, which is what Mermaid does and — more to
 * the point — is what the author was looking at when they wrote the diagram. A
 * later `participant A as Alice` upgrades the label of a column an earlier
 * message already created, for the same reason the flowchart keeps the first
 * real label it is given: the second mention of a name usually carries no label
 * at all, and letting it overwrite would blank the box.
 */
class Cast {
  private readonly order: string[] = []
  private readonly byId = new Map<string, SequenceParticipant>()

  mention(id: string): void {
    if (this.byId.has(id)) {
      return
    }

    this.order.push(id)
    this.byId.set(id, { actor: false, id, label: id })
  }

  declare(id: string, label: string, actor: boolean): void {
    this.mention(id)

    const existing = this.byId.get(id) as SequenceParticipant

    existing.actor = actor

    if (label) {
      existing.label = label
    }
  }

  get size(): number {
    return this.order.length
  }

  list(): SequenceParticipant[] {
    return this.order.map(id => this.byId.get(id) as SequenceParticipant)
  }
}

/**
 * One line, appended to whichever branch is currently open.
 *
 * The frame stack is explicit rather than recursive because the input is a flat
 * list of lines and the nesting is implied by `end`. An unbalanced diagram —
 * every diagram that is still streaming — leaves the stack non-empty, and the
 * caller reads that as "not renderable yet".
 */
interface OpenFrame {
  frame: SequenceFrame
  /** The branch new steps go into: the last one declared. */
  branch: SequenceBranch
}

function parseLine(line: string, cast: Cast, stack: OpenFrame[], root: SequenceStep[]): boolean {
  const into = stack.length ? (stack[stack.length - 1] as OpenFrame).branch.steps : root

  // An arrow is looked for FIRST, and the keyword forms after it. A participant
  // called `alt` is unlikely but possible, and a message from it would otherwise
  // be read as the opening of a frame — whereas no frame label, note or
  // declaration can begin with a name followed by an arrow, so trying the arrow
  // first cannot take a line away from the forms below.
  const pattern = MESSAGE_PATTERNS.find(candidate => candidate.re.test(line))

  if (pattern) {
    const match = pattern.re.exec(line) as RegExpExecArray
    const from = match[1] as string
    const to = match[3] as string

    cast.mention(from)
    cast.mention(to)

    into.push({
      activates: match[2] === '+',
      dashed: pattern.arrow.dashed,
      deactivates: match[2] === '-',
      from,
      head: pattern.arrow.head,
      kind: 'message',
      text: cleanLabel(match[4]),
      to
    })

    return true
  }

  const participant = PARTICIPANT_RE.exec(line)

  if (participant) {
    const actor = (participant[1] as string).toLowerCase() === 'actor'

    cast.declare(participant[2] as string, cleanLabel(participant[3]), actor)

    return true
  }

  const note = NOTE_RE.exec(line)

  if (note) {
    const placement = (note[1] as string).toLowerCase().startsWith('over')
      ? 'over'
      : (note[1] as string).toLowerCase().startsWith('left')
        ? 'left'
        : 'right'
    const named = (note[2] as string)
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)

    // `Note left of A,B` is not a thing, and a note over three columns is a
    // banner rather than a note. Both are refusals rather than guesses.
    if (!named.length || named.length > 2 || (placement !== 'over' && named.length > 1)) {
      return false
    }

    if (named.some(entry => !WHOLE_ID_RE.test(entry))) {
      return false
    }

    for (const entry of named) {
      cast.mention(entry)
    }

    into.push({
      from: named[0] as string,
      kind: 'note',
      placement,
      text: cleanLabel(note[3]),
      to: (named[1] ?? named[0]) as string
    })

    return true
  }

  const frame = FRAME_RE.exec(line)

  if (frame) {
    if (stack.length >= MAX_DEPTH) {
      return false
    }

    const branch: SequenceBranch = { label: cleanLabel(frame[2]), steps: [] }
    const opened: SequenceFrame = {
      branches: [branch],
      kind: 'frame',
      word: (frame[1] as string).toLowerCase() as SequenceFrameWord
    }

    into.push(opened)
    stack.push({ branch, frame: opened })

    return true
  }

  const branch = BRANCH_RE.exec(line)

  if (branch) {
    const open = stack[stack.length - 1]
    const word = (branch[1] as string).toLowerCase()

    // `else` belongs to an `alt` and `and` to a `par`. A branch word in the
    // wrong frame is a diagram that does not say what it looks like it says.
    if (!open || (word === 'else' && open.frame.word !== 'alt') || (word === 'and' && open.frame.word !== 'par')) {
      return false
    }

    const next: SequenceBranch = { label: cleanLabel(branch[2]), steps: [] }

    open.frame.branches.push(next)
    open.branch = next

    return true
  }

  if (END_RE.test(line)) {
    return stack.pop() !== undefined
  }

  return false
}

/** Every step in the tree, so the limits count what the drawing will hold. */
function countSteps(steps: readonly SequenceStep[]): number {
  return steps.reduce(
    (total, step) =>
      total + 1 + (step.kind === 'frame' ? countSteps(step.branches.flatMap(branch => branch.steps)) : 0),
    0
  )
}

/** Whether anything in the tree is actually drawn, rather than only framed. */
function hasContent(steps: readonly SequenceStep[]): boolean {
  return steps.some(step => (step.kind === 'frame' ? step.branches.some(branch => hasContent(branch.steps)) : true))
}

/**
 * Parse one `sequenceDiagram` fence, or answer `null`.
 *
 * `null` means "show the source", never "show nothing". Every caller treats it
 * that way and the tests pin that they do.
 */
export function parseSequence(source: string): SequenceDiagram | null {
  if (!source || source.length > MAX_SOURCE) {
    return null
  }

  const lines = source
    .split('\n')
    .map(line => line.replace(/%%.*$/u, '').trim())
    .filter(Boolean)

  const header = lines.shift()

  if (!header || !HEADER_RE.test(header)) {
    return null
  }

  const cast = new Cast()
  const steps: SequenceStep[] = []
  const stack: OpenFrame[] = []

  for (const line of lines) {
    if (!parseLine(line, cast, stack, steps)) {
      return null
    }
  }

  // A frame still open is a diagram that has not finished arriving. The fence
  // shows the source until the `end` does.
  if (stack.length) {
    return null
  }

  if (cast.size < 1 || cast.size > MAX_PARTICIPANTS || countSteps(steps) > MAX_STEPS) {
    return null
  }

  // A cast with nothing happening between them is a row of boxes, and the
  // source says more than that picture would.
  if (!hasContent(steps)) {
    return null
  }

  return { participants: cast.list(), steps }
}
