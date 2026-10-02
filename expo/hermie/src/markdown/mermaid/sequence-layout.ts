/**
 * A parsed sequence diagram → coordinates, in one synchronous pass.
 *
 * ## Why the geometry is computed and not measured
 *
 * The same reason the flowchart's is, and it is not a preference. Every number
 * below comes out of a character count and the font size, so the drawing's height
 * is known before it mounts. A picture that settles a frame or two after it is
 * laid out moves the reader of an INVERTED list by exactly the correction —
 * `docs/platform-notes.md` has that measurement for `Show more` — and ADR-0020 is
 * the decision it produced.
 *
 * ## The layout
 *
 * A sequence diagram is a table with no cells: the columns are participants and
 * the vertical axis is TIME. So this is one walk down the steps in source order
 * with no reordering of any kind, accumulating `y`. A frame recurses into its
 * branches and its box closes at whatever `y` its contents reached.
 *
 * Two things are settled before the walk, because they decide the columns:
 *
 *  - a column is at least as wide as its own head box, and
 *  - the gap between two ADJACENT columns is at least as wide as the widest
 *    message label that crosses it. Without that rule a long label is drawn over
 *    the neighbouring lifelines, which is the one way this drawing stops being
 *    readable rather than merely tight. A label crossing more than one gap is
 *    left alone: it already has the room.
 *
 * Widening is safe because `Mermaid.tsx` scales the finished drawing down to the
 * bubble's width as a whole. The picture gets smaller; nothing is ever clipped.
 *
 * ## Frames need the width, and the width needs the frames
 *
 * A `loop` box spans the drawing, and what the drawing is wide enough for is
 * decided by the messages inside that box. So frames are recorded during the walk
 * with their nesting depth and are given their `x` and `width` in a short second
 * pass, once the width is known. Two passes is the honest way round a circular
 * dependency; guessing a width and clamping afterwards is not.
 */

import {
  diagramFontSize,
  diagramLineHeight,
  labelBoxWidth,
  textWidth,
  widestWidth,
  wrapToWidth,
  type DiagramText
} from './labels'
import type { SequenceDiagram, SequenceHead, SequenceStep } from './sequence'

/** A lifeline: the vertical line under one head box. */
export interface SequenceLifeline {
  x: number
  top: number
  bottom: number
}

export interface SequenceHeadBox {
  x: number
  y: number
  width: number
  height: number
  actor: boolean
}

/** A box with no other decoration: a note, or an activation bar. */
export interface SequenceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SequenceArrow {
  /** Two points for a message between columns, four for a self-message loop. */
  points: { x: number; y: number }[]
  head: SequenceHead
  dashed: boolean
}

export interface SequenceFrameBox {
  x: number
  y: number
  width: number
  height: number
  /** The keyword tag in the top-left corner, already sized. */
  tag: SequenceRect
  /** Where each `else` or `and` divider is drawn, top to bottom. */
  dividers: number[]
}

export interface SequenceLayout {
  width: number
  height: number
  fontSize: number
  lifelines: SequenceLifeline[]
  heads: SequenceHeadBox[]
  notes: SequenceRect[]
  activations: SequenceRect[]
  arrows: SequenceArrow[]
  frames: SequenceFrameBox[]
  /** Every label in the drawing, placed. */
  texts: DiagramText[]
}

/** The drawing's own margin, so a head box and a frame are never clipped. */
const MARGIN = 10

/** Air inside a head box and inside a note. */
const HEAD_PADDING_X = 10
const HEAD_PADDING_Y = 6
const NOTE_PADDING = 6

/** A head box is never narrower or wider than this, whatever its label says. */
const MIN_HEAD_WIDTH = 52
const MAX_HEAD_WIDTH = 128

/** The least air between two head boxes. */
const MIN_COLUMN_GAP = 26

/** Air around a message label, so it clears the lifelines it sits between. */
const LABEL_MARGIN = 10

/** Between a message label and the arrow under it, and below the arrow. */
const LABEL_GAP = 3
const MESSAGE_GAP = 14

/** Below a note, and below a frame. */
const NOTE_GAP = 12
const FRAME_GAP = 12

/** How far a self-message's loop reaches to the right of its own lifeline. */
const SELF_REACH = 26

/** A frame's own padding, above its first step and below its last. */
const FRAME_TOP_PAD = 5
const FRAME_BOTTOM_PAD = 8

/** A frame is inset by this much per level of nesting, on each side. */
const FRAME_INSET = 6

/** An activation bar's width, centred on the lifeline. */
const ACTIVATION_WIDTH = 8

/** The size a frame's keyword tag is set at, relative to the diagram's own. */
const TAG_SCALE = 0.86

/** Between the head of the drawing and its first step. */
const BODY_TOP_GAP = 16

/**
 * A message's own label, wrapped generously.
 *
 * Generously because the width this label wants is part of what decides how far
 * apart two columns sit. Wrapping it narrow to fit a gap that has not been
 * computed yet would make the whole diagram taller for nothing.
 */
function messageLines(text: string, fontSize: number): string[] {
  return wrapToWidth(text, fontSize, MAX_HEAD_WIDTH * 2)
}

interface Column {
  id: string
  centre: number
  width: number
}

/** Every step in the tree, flattened, so one pass can read all the labels. */
function everyStep(steps: readonly SequenceStep[]): SequenceStep[] {
  return steps.flatMap(step =>
    step.kind === 'frame' ? [step, ...everyStep(step.branches.flatMap(branch => branch.steps))] : [step]
  )
}

/** Each participant's label, already broken into the lines its box will draw. */
function headLinesOf(diagram: SequenceDiagram, fontSize: number): Map<string, string[]> {
  return new Map(
    diagram.participants.map(participant => [
      participant.id,
      wrapToWidth(participant.label, fontSize, MAX_HEAD_WIDTH - HEAD_PADDING_X * 2)
    ])
  )
}

/** Where each column sits, and how wide its head box is. */
function columnsOf(diagram: SequenceDiagram, fontSize: number, headLines: Map<string, string[]>): Column[] {
  const widths = diagram.participants.map(participant => {
    const lines = headLines.get(participant.id) ?? ['']

    return Math.min(MAX_HEAD_WIDTH, Math.max(MIN_HEAD_WIDTH, widestWidth(lines, fontSize) + HEAD_PADDING_X * 2))
  })

  const index = new Map(diagram.participants.map((participant, at) => [participant.id, at]))
  const needed = new Map<number, number>()

  for (const step of everyStep(diagram.steps)) {
    if (step.kind === 'frame') {
      continue
    }

    const from = index.get(step.from)
    const to = index.get(step.to)

    if (from === undefined || to === undefined) {
      continue
    }

    const left = Math.min(from, to)
    const right = Math.max(from, to)

    // Only a label that crosses exactly one gap can widen it. A longer reach
    // already has more than one column's worth of room under it.
    if (right - left !== 1) {
      continue
    }

    const want = labelBoxWidth(messageLines(step.text, fontSize), fontSize, LABEL_MARGIN * 2)

    needed.set(left, Math.max(needed.get(left) ?? 0, want))
  }

  const columns: Column[] = []

  diagram.participants.forEach((participant, at) => {
    const width = widths[at] ?? MIN_HEAD_WIDTH
    const previous = columns[at - 1]
    const centre = previous
      ? previous.centre + Math.max(previous.width / 2 + width / 2 + MIN_COLUMN_GAP, needed.get(at - 1) ?? 0)
      : MARGIN + width / 2

    columns.push({ centre, id: participant.id, width })
  })

  return columns
}

/** A frame's box, plus everything about it that needs the drawing's width. */
interface PendingFrame {
  box: SequenceFrameBox
  depth: number
  /** Indices into `texts`, each with the offset it wants from the frame's left. */
  labels: { at: number; dx: number }[]
}

/** The state one walk down the steps carries. */
interface Pass {
  fontSize: number
  lineHeight: number
  columns: Map<string, Column>
  arrows: SequenceArrow[]
  notes: SequenceRect[]
  activations: SequenceRect[]
  frames: PendingFrame[]
  texts: DiagramText[]
  /** Open activations per column, as the `y` each one started at. */
  open: Map<string, number[]>
  /** The furthest right anything has reached, so nothing is clipped. */
  right: number
  /**
   * The furthest LEFT anything has reached, which can be negative.
   *
   * Only `Note left of` the first column can reach outside the columns, and when
   * it does the whole drawing is shifted right rather than the note being moved:
   * a note nudged back inside would no longer be beside the participant it names.
   */
  left: number
}

function openActivation(pass: Pass, id: string, y: number): void {
  const started = pass.open.get(id)

  if (started) {
    started.push(y)
  } else {
    pass.open.set(id, [y])
  }
}

function closeActivation(pass: Pass, id: string, y: number): void {
  const started = pass.open.get(id)
  const from = started?.pop()
  const column = pass.columns.get(id)

  if (from === undefined || !column) {
    return
  }

  pass.activations.push({
    height: Math.max(Math.round(pass.lineHeight / 2), y - from),
    width: ACTIVATION_WIDTH,
    x: column.centre - ACTIVATION_WIDTH / 2,
    y: from
  })
}

function placeMessage(step: Extract<SequenceStep, { kind: 'message' }>, y: number, pass: Pass): number {
  const from = pass.columns.get(step.from)
  const to = pass.columns.get(step.to)

  if (!from || !to) {
    return y
  }

  const lines = step.text ? messageLines(step.text, pass.fontSize) : []
  const labelHeight = lines.length * pass.lineHeight
  const labelWidth = lines.length ? labelBoxWidth(lines, pass.fontSize) : 0
  const arrowY = y + labelHeight + LABEL_GAP

  if (from.id === to.id) {
    // A message to its own column is drawn as a loop out to the right and back,
    // which is the only place on the drawing with room for one.
    const loopHeight = pass.lineHeight + 6
    const out = from.centre + SELF_REACH

    pass.arrows.push({
      dashed: step.dashed,
      head: step.head,
      points: [
        { x: from.centre, y: arrowY },
        { x: out, y: arrowY },
        { x: out, y: arrowY + loopHeight },
        { x: from.centre, y: arrowY + loopHeight }
      ]
    })

    if (lines.length) {
      pass.texts.push({
        align: 'left',
        chip: true,
        height: labelHeight,
        lines,
        size: pass.fontSize,
        tone: 'ink',
        width: labelWidth,
        x: out + 4,
        y
      })
    }

    pass.right = Math.max(pass.right, out + 4 + labelWidth)

    if (step.activates) {
      openActivation(pass, to.id, arrowY)
    }

    if (step.deactivates) {
      closeActivation(pass, from.id, arrowY + loopHeight)
    }

    return arrowY + loopHeight + MESSAGE_GAP
  }

  pass.arrows.push({
    dashed: step.dashed,
    head: step.head,
    points: [
      { x: from.centre, y: arrowY },
      { x: to.centre, y: arrowY }
    ]
  })

  if (lines.length) {
    const middle = (from.centre + to.centre) / 2

    pass.texts.push({
      align: 'center',
      chip: true,
      height: labelHeight,
      lines,
      size: pass.fontSize,
      tone: 'ink',
      width: labelWidth,
      x: middle - labelWidth / 2,
      y
    })
    pass.right = Math.max(pass.right, middle + labelWidth / 2)
  }

  if (step.activates) {
    openActivation(pass, to.id, arrowY)
  }

  if (step.deactivates) {
    closeActivation(pass, from.id, arrowY)
  }

  return arrowY + MESSAGE_GAP
}

function placeNote(step: Extract<SequenceStep, { kind: 'note' }>, y: number, pass: Pass): number {
  const from = pass.columns.get(step.from)
  const to = pass.columns.get(step.to)

  if (!from || !to) {
    return y
  }

  const span = step.placement === 'over' ? Math.abs(to.centre - from.centre) : 0
  const room = Math.max(MIN_HEAD_WIDTH, span + MAX_HEAD_WIDTH - HEAD_PADDING_X * 2)
  const lines = wrapToWidth(step.text, pass.fontSize, room)
  const width = Math.max(MIN_HEAD_WIDTH, widestWidth(lines, pass.fontSize) + NOTE_PADDING * 2)
  const height = lines.length * pass.lineHeight + NOTE_PADDING * 2

  // `over` straddles the columns it names; `left of` and `right of` sit beside
  // one, which is the only case where a note reaches outside the columns.
  const overCentre = (Math.min(from.centre, to.centre) + Math.max(from.centre, to.centre)) / 2
  const x =
    step.placement === 'over'
      ? overCentre - width / 2
      : step.placement === 'left'
        ? from.centre - from.width / 2 - 8 - width
        : from.centre + from.width / 2 + 8

  pass.notes.push({ height, width, x, y })
  pass.left = Math.min(pass.left, x)
  pass.texts.push({
    align: 'center',
    height: height - NOTE_PADDING * 2,
    lines,
    size: pass.fontSize,
    tone: 'ink',
    width: width - NOTE_PADDING * 2,
    x: x + NOTE_PADDING,
    y: y + NOTE_PADDING
  })
  pass.right = Math.max(pass.right, x + width)

  return y + height + NOTE_GAP
}

function placeFrame(step: Extract<SequenceStep, { kind: 'frame' }>, y: number, depth: number, pass: Pass): number {
  const tagSize = Math.max(9, Math.round(pass.fontSize * TAG_SCALE))
  const tagLine = diagramLineHeight(tagSize)
  const tagHeight = tagLine + 2
  const tagWidth = textWidth(step.word, tagSize) + 12
  const dividers: number[] = []
  const labels: { at: number; dx: number }[] = []
  const top = y
  let at = y + FRAME_TOP_PAD

  // The tag's own word. Its `x` is the frame's, which is not known yet.
  labels.push({ at: pass.texts.length, dx: 0 })
  pass.texts.push({
    align: 'center',
    height: tagHeight,
    lines: [step.word],
    size: tagSize,
    tone: 'muted',
    width: tagWidth,
    x: 0,
    y: top + (tagHeight - tagLine) / 2
  })

  step.branches.forEach((branch, index) => {
    if (index > 0) {
      at += 5
      dividers.push(at)
      at += 4
    }

    const lines = branch.label ? messageLines(branch.label, pass.fontSize) : []
    const labelHeight = lines.length * pass.lineHeight
    // The head branch's label sits beside the tag; a later branch's opens its
    // own row under the divider, which is where Mermaid puts an `else`.
    const labelY = index === 0 ? top + FRAME_TOP_PAD : at

    if (lines.length) {
      labels.push({ at: pass.texts.length, dx: index === 0 ? tagWidth + 6 : 6 })
      pass.texts.push({
        align: 'left',
        chip: true,
        height: labelHeight,
        lines,
        size: pass.fontSize,
        tone: 'ink',
        width: labelBoxWidth(lines, pass.fontSize),
        x: 0,
        y: labelY
      })
    }

    at = Math.max(at, labelY + Math.max(labelHeight, index === 0 ? tagHeight : 0)) + 4
    at = placeSteps(branch.steps, at, depth + 1, pass)
  })

  const bottom = at + FRAME_BOTTOM_PAD

  pass.frames.push({
    box: {
      dividers,
      height: bottom - top,
      tag: { height: tagHeight, width: tagWidth, x: 0, y: top },
      width: 0,
      x: 0,
      y: top
    },
    depth,
    labels
  })

  return bottom + FRAME_GAP
}

function placeSteps(steps: readonly SequenceStep[], y: number, depth: number, pass: Pass): number {
  let at = y

  for (const step of steps) {
    if (step.kind === 'message') {
      at = placeMessage(step, at, pass)

      continue
    }

    if (step.kind === 'note') {
      at = placeNote(step, at, pass)

      continue
    }

    at = placeFrame(step, at, depth, pass)
  }

  return at
}

/**
 * Place a parsed sequence diagram.
 *
 * One walk, source order, no reordering: the vertical axis is time and the author
 * wrote the time. The frames are the only thing corrected afterwards, and only
 * because a full-width box cannot know its width until the walk that decides it
 * has finished.
 */
export function layoutSequence(diagram: SequenceDiagram, bodyFontSize: number): SequenceLayout {
  const fontSize = diagramFontSize(bodyFontSize)
  const lineHeight = diagramLineHeight(fontSize)
  const headLines = headLinesOf(diagram, fontSize)
  const columns = columnsOf(diagram, fontSize, headLines)

  // One head height for every column, so the lifelines all start on one line.
  const headHeight = diagram.participants.reduce(
    (tallest, participant) =>
      Math.max(tallest, (headLines.get(participant.id) ?? ['']).length * lineHeight + HEAD_PADDING_Y * 2),
    lineHeight + HEAD_PADDING_Y * 2
  )

  const heads: SequenceHeadBox[] = []
  const texts: DiagramText[] = []

  columns.forEach((column, at) => {
    const participant = diagram.participants[at]

    if (!participant) {
      return
    }

    const lines = headLines.get(participant.id) ?? ['']
    const textWidthAvailable = column.width - HEAD_PADDING_X

    heads.push({
      actor: participant.actor,
      height: headHeight,
      width: column.width,
      x: column.centre - column.width / 2,
      y: MARGIN
    })
    texts.push({
      align: 'center',
      height: lines.length * lineHeight,
      lines,
      size: fontSize,
      tone: 'ink',
      width: textWidthAvailable,
      x: column.centre - textWidthAvailable / 2,
      y: MARGIN + (headHeight - lines.length * lineHeight) / 2
    })
  })

  const pass: Pass = {
    activations: [],
    arrows: [],
    columns: new Map(columns.map(column => [column.id, column])),
    fontSize,
    frames: [],
    left: 0,
    lineHeight,
    notes: [],
    open: new Map(),
    right: columns.reduce((most, column) => Math.max(most, column.centre + column.width / 2), 0),
    texts
  }

  const bottom = placeSteps(diagram.steps, MARGIN + headHeight + BODY_TOP_GAP, 0, pass)
  const height = Math.round(bottom + MARGIN)
  // A note to the left of the first column reaches behind the origin, and the
  // drawing has no negative half: everything moves right by what it overhung.
  const shift = pass.left < MARGIN ? Math.ceil(MARGIN - pass.left) : 0
  const width = Math.round(pass.right + shift + MARGIN)

  // An activation the author never closed runs to the foot of the drawing, which
  // is what Mermaid does with one and the only reading that does not lose it.
  for (const [id, stack] of pass.open) {
    const column = pass.columns.get(id)

    for (const from of stack) {
      if (column) {
        pass.activations.push({
          height: Math.max(Math.round(lineHeight / 2), height - MARGIN - from),
          width: ACTIVATION_WIDTH,
          x: column.centre - ACTIVATION_WIDTH / 2,
          y: from
        })
      }
    }
  }

  // The shift lands on everything the walk placed, before the frames are given
  // their box: a frame spans the FINISHED width, so it is placed in the shifted
  // space directly rather than being moved into it.
  if (shift) {
    for (const box of [...heads, ...pass.notes, ...pass.activations]) {
      box.x += shift
    }

    for (const arrow of pass.arrows) {
      for (const point of arrow.points) {
        point.x += shift
      }
    }

    for (const text of pass.texts) {
      text.x += shift
    }
  }

  const frames = pass.frames.map(pending => {
    const inset = MARGIN / 2 + FRAME_INSET * pending.depth
    const box = pending.box

    box.x = inset
    box.width = Math.max(MIN_HEAD_WIDTH, width - inset * 2)
    box.tag.x = inset

    for (const label of pending.labels) {
      const text = pass.texts[label.at]

      if (text) {
        text.x = inset + label.dx
      }
    }

    return box
  })

  const lifelines: SequenceLifeline[] = columns.map(column => ({
    bottom: height - MARGIN,
    top: MARGIN + headHeight,
    x: column.centre + shift
  }))

  return {
    activations: pass.activations,
    arrows: pass.arrows,
    fontSize,
    frames,
    height,
    heads,
    lifelines,
    notes: pass.notes,
    texts: pass.texts,
    width
  }
}
