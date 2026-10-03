/**
 * A ```mermaid fence, drawn.
 *
 * A lazy chunk (`../lazy.ts`). No `mermaid` library: it is megabytes and draws
 * through `innerHTML`, and its `securityLevel` exists because its renderer can be
 * made to run script and follow links out of a label. Here the package's own
 * parsers and layouts (`@hermie/markdown/mermaid/*`, the ones the Expo app draws
 * from) turn the source into numbers and strings, and `Flowchart`,
 * `SequenceDiagram` and `PieChart` turn those into SVG elements. A label is
 * characters in a `text`; there is no link, no script and no markup in a
 * drawing, so there is nothing to sandbox.
 *
 * Three kinds are drawn: a flowchart (`flowchart`, `graph`), a sequence diagram
 * and a pie. Anything else (a `gantt`, a `classDiagram`, a `subgraph`, a
 * half-streamed fence) comes back from every parser as `null` and is shown as its
 * source, which is readable, copyable and exactly what the model wrote. A drawing
 * is shown in the code block's box with a "Show source" toggle, and is named by
 * its source for assistive technology.
 */
import { layoutMermaid, type MermaidLayout } from '@hermie/markdown/mermaid/layout'
import { parseMermaid } from '@hermie/markdown/mermaid/parse'
import { parsePie } from '@hermie/markdown/mermaid/pie'
import { layoutPie, type PieLayout } from '@hermie/markdown/mermaid/pie-layout'
import { parseSequence } from '@hermie/markdown/mermaid/sequence'
import { layoutSequence, type SequenceLayout } from '@hermie/markdown/mermaid/sequence-layout'
import { memo, useMemo } from 'react'

import { CodeBlock } from '../CodeBlock'
import { LAYOUT_SIZE } from './Diagram'
import { Flowchart } from './Flowchart'
import { PieChart } from './PieChart'
import { SequenceDiagram } from './SequenceDiagram'

/** The fence's info string, and the label in the corner of its box. */
export const MERMAID_LANGUAGE = 'mermaid'

/** Which of the three drawings a fence is, already laid out. */
export type Drawing =
  | { kind: 'flowchart'; layout: MermaidLayout }
  | { kind: 'sequence'; layout: SequenceLayout }
  | { kind: 'pie'; layout: PieLayout }

/**
 * The parsers in turn (each reads the header line first, so the two that decline
 * cost a regular expression apiece), and the layout of the one that answers.
 * The Expo app's `draw`.
 */
export function drawMermaid(source: string, fontSize = LAYOUT_SIZE): Drawing | null {
  const graph = parseMermaid(source)

  if (graph) {
    return { kind: 'flowchart', layout: layoutMermaid(graph, fontSize) }
  }

  const sequence = parseSequence(source)

  if (sequence) {
    return { kind: 'sequence', layout: layoutSequence(sequence, fontSize) }
  }

  const pie = parsePie(source)

  if (pie) {
    return { kind: 'pie', layout: layoutPie(pie, fontSize) }
  }

  return null
}

function DrawingView({ drawing, label }: { drawing: Drawing; label: string }) {
  switch (drawing.kind) {
    case 'flowchart':
      return <Flowchart label={label} layout={drawing.layout} />
    case 'sequence':
      return <SequenceDiagram label={label} layout={drawing.layout} />
    case 'pie':
      return <PieChart label={label} layout={drawing.layout} />
  }
}

function MermaidDiagramView({ source }: { source: string }) {
  const code = source.replace(/\n$/u, '')
  const drawing = useMemo(() => drawMermaid(code), [code])

  return (
    <CodeBlock
      code={code}
      kind="mermaid"
      label={MERMAID_LANGUAGE}
      {...(drawing ? { drawing: <DrawingView drawing={drawing} label={code} /> } : {})}
    />
  )
}

/**
 * Memoised on the source: a streaming reply re-renders its last block on every
 * delta, and a settled diagram is not parsed and laid out again.
 */
export const MermaidDiagram = memo(MermaidDiagramView)
