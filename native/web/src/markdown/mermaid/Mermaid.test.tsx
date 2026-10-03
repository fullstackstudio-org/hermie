/**
 * Mermaid as the reader meets it: each of the three kinds drawn element for
 * element from the package's layout, named by its source, with the source on
 * request; anything the parsers decline shown as source.
 */
import { resetBlockCache } from '@hermie/markdown'
import { diagramLineHeight } from '@hermie/markdown/mermaid/labels'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mermaidRenderer } from '../lazy'
import { Markdown } from '../Markdown'
import { polyline } from './Diagram'
import { drawMermaid } from './Mermaid'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn<(text: string) => Promise<boolean>>() }))

vi.mock('../../platform/clipboard', () => clipboard)

beforeAll(async () => {
  await mermaidRenderer.load()
})

beforeEach(() => {
  resetBlockCache()
  clipboard.writeClipboard.mockReset()
  clipboard.writeClipboard.mockResolvedValue(true)
})

const fence = (source: string): string => `\`\`\`mermaid\n${source}\n\`\`\``

/**
 * The drawing named by `source`: its accessible name is the source with the white
 * space folded, as every accessible name is, and its label is the source itself.
 */
function drawingOf(source: string): HTMLElement {
  const svg = screen.getByRole('img', { name: source.replace(/\s+/gu, ' ').trim() })

  expect(svg.getAttribute('aria-label')).toBe(source)

  return svg
}

const FLOWCHART = [
  'flowchart LR',
  '  A([Start]) --> B{Ready?}',
  '  B -->|yes| C[Go]',
  '  B -.-> D((Wait))',
  '  C ==> E[[Done]]',
  '  D --- F{{Hold}}',
  '  F --> G(Round)'
].join('\n')

const SEQUENCE = [
  'sequenceDiagram',
  '  actor U as User',
  '  participant S as Server',
  '  U->>+S: Hello',
  '  loop every second',
  '    S-->>U: tick',
  '  end',
  '  Note right of S: thinking',
  '  S-)U: async',
  '  S-xU: lost',
  '  S-->>-U: Bye'
].join('\n')

const PIE = ['pie title Pets', '  "Dogs" : 386', '  "Cats" : 85.5', '  "Rats" : 15'].join('\n')

/** The text of every `text` element, in document order. */
const texts = (root: Element): string[] => Array.from(root.querySelectorAll('text')).map(text => text.textContent ?? '')

describe('a flowchart', () => {
  it('is an image named by its source, drawn from layoutMermaid', () => {
    const { container } = render(<Markdown text={fence(FLOWCHART)} />)
    const svg = drawingOf(FLOWCHART)
    const drawing = drawMermaid(FLOWCHART)

    if (drawing?.kind !== 'flowchart') {
      throw new Error('the fixture is a flowchart')
    }

    const { layout } = drawing

    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`)
    expect(svg.getAttribute('width')).toBe(`${layout.width / 16}em`)
    expect(container.querySelector('.md-code')?.getAttribute('data-kind')).toBe('mermaid')
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('mermaid')

    // One edge path per edge, along the layout's points, and a head on each arrow.
    const edges = Array.from(svg.querySelectorAll('path.md-dg-edge'))

    expect(edges.map(edge => edge.getAttribute('d'))).toEqual(layout.edges.map(edge => polyline(edge.points)))
    expect(svg.querySelectorAll('.md-dg-edge-head')).toHaveLength(layout.edges.filter(edge => edge.arrow).length)
    expect(edges.map(edge => edge.getAttribute('stroke-dasharray'))).toEqual(
      layout.edges.map(edge => (edge.stroke === 'dotted' ? '4 3' : null))
    )
    expect(edges.map(edge => edge.getAttribute('stroke-width'))).toEqual(
      layout.edges.map(edge => (edge.stroke === 'thick' ? '2.6' : '1.4'))
    )

    // One shape per node, of the element its shape is drawn with.
    const shapes = Array.from(svg.querySelectorAll('.md-dg-node'))
    const element = { circle: 'circle', hexagon: 'polygon', rhombus: 'polygon' } as Record<string, string>

    expect(shapes.map(shape => shape.tagName)).toEqual(layout.nodes.map(node => element[node.shape] ?? 'rect'))
    // A subroutine has its two inner rules.
    expect(svg.querySelectorAll('line.md-dg-ink')).toHaveLength(
      2 * layout.nodes.filter(node => node.shape === 'subroutine').length
    )

    // Every node's lines and every edge label, as text.
    for (const node of layout.nodes) {
      for (const line of node.lines) {
        expect(texts(svg)).toContain(line)
      }
    }

    expect(texts(svg)).toContain('yes')
    expect(svg.querySelectorAll('.md-dg-chip')).toHaveLength(layout.edges.filter(edge => edge.label).length)
  })

  it('centres a node’s label in its box', () => {
    render(<Markdown text={fence('flowchart TD\n  A[Only one] --> B')} />)
    const drawing = drawMermaid('flowchart TD\n  A[Only one] --> B')
    const node = drawing?.kind === 'flowchart' ? drawing.layout.nodes[0] : undefined
    const label = screen.getByRole('img').querySelector('text')

    expect(label?.getAttribute('text-anchor')).toBe('middle')
    expect(Number(label?.getAttribute('x'))).toBeCloseTo((node?.x ?? 0) + (node?.width ?? 0) / 2)
  })
})

describe('a sequence diagram', () => {
  it('is drawn from layoutSequence: heads, lifelines, bars, notes, frames, arrows and every label', () => {
    render(<Markdown text={fence(SEQUENCE)} />)
    const svg = drawingOf(SEQUENCE)
    const drawing = drawMermaid(SEQUENCE)

    if (drawing?.kind !== 'sequence') {
      throw new Error('the fixture is a sequence diagram')
    }

    const { layout } = drawing

    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`)
    expect(svg.querySelectorAll('line.md-dg-lifeline')).toHaveLength(layout.lifelines.length)
    expect(svg.querySelectorAll('rect.md-dg-node')).toHaveLength(layout.heads.length + layout.activations.length)
    expect(svg.querySelectorAll('rect.md-dg-note')).toHaveLength(layout.notes.length)
    expect(svg.querySelectorAll('rect.md-dg-frame')).toHaveLength(layout.frames.length)
    expect(
      Array.from(svg.querySelectorAll('path.md-dg-arrow')).map(arrow => [
        arrow.getAttribute('d'),
        arrow.getAttribute('stroke-dasharray')
      ])
    ).toEqual(layout.arrows.map(arrow => [polyline(arrow.points), arrow.dashed ? '5 3' : null]))

    // An actor's head is a stadium, a participant's a rectangle.
    const heads = Array.from(svg.querySelectorAll('rect.md-dg-node')).slice(layout.activations.length)

    expect(heads.map(head => Number(head.getAttribute('rx')))).toEqual(
      layout.heads.map(head => (head.actor ? head.height / 2 : 4))
    )

    // The three ends: a filled head, an open one (two strokes), a cross (two strokes).
    const filled = layout.arrows.filter(arrow => arrow.head === 'filled').length
    const stroked = layout.arrows.filter(arrow => arrow.head === 'open' || arrow.head === 'cross').length

    expect(svg.querySelectorAll('polygon.md-dg-ink-fill')).toHaveLength(filled)
    expect(svg.querySelectorAll('line.md-dg-ink')).toHaveLength(2 * stroked)

    expect(texts(svg)).toEqual(layout.texts.flatMap(text => text.lines))
  })
})

describe('a pie', () => {
  it('is drawn from layoutPie: a slice per value, a swatch per row, the legend as text', () => {
    render(<Markdown text={fence(PIE)} />)
    const svg = drawingOf(PIE)
    const drawing = drawMermaid(PIE)

    if (drawing?.kind !== 'pie') {
      throw new Error('the fixture is a pie')
    }

    const { layout } = drawing

    expect(Array.from(svg.querySelectorAll('path.md-dg-slice')).map(slice => slice.getAttribute('d'))).toEqual(
      layout.arcs.map(arc => arc.path)
    )
    expect(Array.from(svg.querySelectorAll('rect.md-dg-slice')).map(swatch => swatch.getAttribute('class'))).toEqual([
      'md-dg-slice md-dg-slice-0',
      'md-dg-slice md-dg-slice-1',
      'md-dg-slice md-dg-slice-2'
    ])
    expect(texts(svg)).toEqual(layout.texts.flatMap(text => text.lines))
    expect(texts(svg)).toContain('Pets')
  })

  it('draws one slice that holds everything as a ring', () => {
    render(<Markdown text={fence('pie\n  "All" : 1')} />)
    const svg = screen.getByRole('img')

    expect(svg.querySelectorAll('circle.md-dg-slice-0')).toHaveLength(1)
    expect(svg.querySelectorAll('circle.md-dg-hole')).toHaveLength(1)
  })

  it('takes the colours in order and starts again after the tenth', () => {
    const source = ['pie', ...Array.from({ length: 10 }, (_unused, index) => `  "S${index}" : ${index + 1}`)].join('\n')

    render(<Markdown text={fence(source)} />)

    const classes = Array.from(screen.getByRole('img').querySelectorAll('rect.md-dg-slice')).map(swatch =>
      swatch.getAttribute('class')
    )

    expect(classes).toEqual(Array.from({ length: 10 }, (_unused, index) => `md-dg-slice md-dg-slice-${index}`))
  })
})

describe('labels', () => {
  it('stacks a label of several lines, a line height apart', () => {
    render(<Markdown text={fence('flowchart TD\n  A["first<br/>second"] --> B')} />)
    const lines = Array.from(screen.getByRole('img').querySelectorAll('text')).slice(0, 2)
    const drawing = drawMermaid('flowchart TD\n  A["first<br/>second"] --> B')
    const size = drawing?.kind === 'flowchart' ? drawing.layout.fontSize : 0

    expect(lines.map(line => line.textContent)).toEqual(['first', 'second'])
    expect(Number(lines[1]?.getAttribute('y')) - Number(lines[0]?.getAttribute('y'))).toBeCloseTo(
      diagramLineHeight(size)
    )
  })
})

describe('the box', () => {
  it('shows the source on request, and the drawing again; copy is always the source', () => {
    const { container } = render(<Markdown text={fence(PIE)} />)
    const toggle = screen.getByRole('button', { name: 'Show source' })

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(PIE)

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(clipboard.writeClipboard).toHaveBeenCalledWith(PIE)

    fireEvent.click(toggle)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it.each([
    ['a kind no parser draws', 'gantt\n  title Plan\n  section One\n  Task :a1, 2026-01-01, 3d'],
    ['a statement the flowchart parser refuses', 'flowchart TD\n  subgraph one\n  A --> B\n  end'],
    ['a click directive', 'flowchart TD\n  A --> B\n  click A "https://example.com"'],
    ['a half-streamed frame', 'sequenceDiagram\n  A->>B: hi\n  loop forever\n  B->>A: again']
  ])('shows %s as its source, with no toggle', (_name, source) => {
    const { container } = render(<Markdown text={fence(source)} />)

    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(source)
    expect(screen.queryByRole('button', { name: 'Show source' })).toBeNull()
  })

  it('draws a diagram once the rest of it has streamed in', () => {
    const whole = 'flowchart LR\n  A --> B'
    const { container, rerender } = render(<Markdown text={'```mermaid\nflowchart LR\n  A --'} />)

    expect(container.querySelector('svg')).toBeNull()

    rerender(<Markdown text={fence(whole)} />)

    expect(drawingOf(whole)).toBeTruthy()
  })
})
