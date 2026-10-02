/**
 * The two diagram kinds that used to be listings: a sequence diagram and a pie.
 *
 * The inputs are the ones an agent actually writes — a request/response exchange
 * with a note and a loop, a three-slice pie — plus the two cases that decide
 * whether the feature is safe rather than merely present:
 *
 *  - a PREFIX of each, because a streaming reply hands the parser one on every
 *    flush, and the answer has to be `null` and a fenced listing rather than half
 *    a picture or an exception;
 *  - a `gantt`, which nothing here draws, because the graceful fallback is the
 *    thing that makes a subset acceptable at all (ADR-0020).
 *
 * The layout is asserted on its arithmetic rather than on its pixels: that the
 * drawing has a size before it mounts, that time runs downwards, and that the
 * columns are in the order the source mentioned them. Those are the three
 * properties the renderer cannot recover if the layout gets them wrong.
 */
import { render, screen } from '@testing-library/react-native'

import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import { parseMermaid } from '../../src/markdown/mermaid/parse'
import { parsePie } from '../../src/markdown/mermaid/pie'
import { layoutPie } from '../../src/markdown/mermaid/pie-layout'
import { parseSequence } from '../../src/markdown/mermaid/sequence'
import { layoutSequence } from '../../src/markdown/mermaid/sequence-layout'
import { ThemeProvider } from '../../src/ui/theme'

const CONTENT_WIDTH = 320

const SEQUENCE = [
  '```mermaid',
  'sequenceDiagram',
  '  participant C as Client',
  '  participant G as Gateway',
  '  actor W as Worker',
  '  C->>+G: POST /run',
  '  Note over C,G: the token is checked first',
  '  loop every flush',
  '    G-->>C: delta',
  '  end',
  '  alt job finished',
  '    G->>W: collect',
  '    W--)G: artefacts',
  '  else timed out',
  '    G-xC: cancelled',
  '  end',
  '  G-->>-C: 200 OK',
  '```'
].join('\n')

const PIE = [
  '```mermaid',
  'pie title Where the minutes went',
  '  "Reading" : 42',
  '  "Writing" : 31',
  '  "Waiting" : 7',
  '```'
].join('\n')

function draw(text: string) {
  return render(
    <ThemeProvider>
      <Markdown maxContentWidth={CONTENT_WIDTH} text={text} />
    </ThemeProvider>
  )
}

/** The bodies of the two fences above, which is what a parser is handed. */
function fenced(source: string): string {
  return source.split('\n').slice(1, -1).join('\n')
}

describe('a sequenceDiagram fence', () => {
  beforeEach(resetBlockCache)

  it('is drawn as a diagram rather than as a listing', () => {
    draw(SEQUENCE)

    expect(screen.getByTestId('markdown-mermaid-sequence')).toBeTruthy()
    // Head boxes carry the `as` label, not the identifier, and the labels are
    // real text — which is what makes them selectable and readable aloud.
    expect(screen.getByText('Client')).toBeTruthy()
    expect(screen.getByText('Gateway')).toBeTruthy()
    expect(screen.getByText('Worker')).toBeTruthy()
    expect(screen.getByText('POST /run')).toBeTruthy()
    expect(screen.getByText('the token is checked first')).toBeTruthy()
    expect(screen.getByText('loop')).toBeTruthy()
    expect(screen.getByText('every flush')).toBeTruthy()
    expect(screen.getByText('alt')).toBeTruthy()
    expect(screen.getByText('timed out')).toBeTruthy()
  })

  it('reads the arrow spellings as the four different ends they are', () => {
    const diagram = parseSequence(
      ['sequenceDiagram', 'A->>B: call', 'B-->>A: reply', 'A-xB: lost', 'A--B: plain', 'A->B: open'].join('\n')
    )

    expect(diagram).not.toBeNull()
    expect(diagram!.steps.map(step => (step.kind === 'message' ? [step.head, step.dashed] : step.kind))).toEqual([
      ['filled', false],
      ['filled', true],
      ['cross', false],
      ['none', true],
      ['open', false]
    ])
  })

  it('reads the activation suffixes without letting them break the message', () => {
    const diagram = parseSequence(['sequenceDiagram', 'A->>+B: work', 'B-->>-A: done'].join('\n'))

    expect(diagram).not.toBeNull()

    const [first, second] = diagram!.steps

    expect(first).toMatchObject({ activates: true, deactivates: false, text: 'work', to: 'B' })
    expect(second).toMatchObject({ activates: false, deactivates: true, from: 'B', text: 'done' })

    // The bar is a real rectangle on the lifeline, between the two arrows.
    const layout = layoutSequence(diagram!, 17)

    expect(layout.activations).toHaveLength(1)
    expect(layout.activations[0]!.height).toBeGreaterThan(0)
  })

  it('places the columns in mention order and lets time run downwards', () => {
    const diagram = parseSequence(['sequenceDiagram', 'A->>B: one', 'B->>C: two'].join('\n')) as NonNullable<
      ReturnType<typeof parseSequence>
    >
    const layout = layoutSequence(diagram, 17)

    expect(diagram.participants.map(participant => participant.id)).toEqual(['A', 'B', 'C'])
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
    expect(layout.lifelines).toHaveLength(3)

    const [first, second, third] = layout.lifelines

    expect(first!.x).toBeLessThan(second!.x)
    expect(second!.x).toBeLessThan(third!.x)

    // Two messages, the second below the first: the vertical axis is time.
    const [one, two] = layout.arrows

    expect(one!.points[0]!.y).toBeLessThan(two!.points[0]!.y)
  })

  it('keeps a self-message inside the drawing rather than off its right edge', () => {
    const diagram = parseSequence(['sequenceDiagram', 'A->>A: retry', 'A->>B: give up'].join('\n'))
    const layout = layoutSequence(diagram!, 17)
    const loop = layout.arrows[0]!

    expect(loop.points).toHaveLength(4)

    for (const point of loop.points) {
      expect(point.x).toBeLessThanOrEqual(layout.width)
    }
  })

  it('shifts the drawing right rather than clipping a note beside the first column', () => {
    const diagram = parseSequence(['sequenceDiagram', 'Note left of A: before anything', 'A->>B: go'].join('\n'))
    const layout = layoutSequence(diagram!, 17)

    for (const note of layout.notes) {
      expect(note.x).toBeGreaterThanOrEqual(0)
    }

    for (const text of layout.texts) {
      expect(text.x).toBeGreaterThanOrEqual(0)
    }
  })

  it('refuses a statement it would have to ignore, and a half-arrived one', () => {
    // `autonumber` asks for numbers this renderer does not draw. Refusing costs
    // one picture; ignoring would print a diagram that is missing what was asked.
    expect(parseSequence(['sequenceDiagram', 'autonumber', 'A->>B: one'].join('\n'))).toBeNull()
    expect(parseSequence(['sequenceDiagram', 'rect rgb(0,0,0)', 'A->>B: one', 'end'].join('\n'))).toBeNull()
    // A frame whose `end` has not streamed yet.
    expect(parseSequence(['sequenceDiagram', 'loop twice', '  A->>B: one'].join('\n'))).toBeNull()
    // An `else` outside an `alt`.
    expect(parseSequence(['sequenceDiagram', 'loop twice', '  A->>B: one', 'else nope', 'end'].join('\n'))).toBeNull()
    // Half an arrow, which is what a flush lands on.
    expect(parseSequence(['sequenceDiagram', 'A->>'].join('\n'))).toBeNull()
    expect(parseSequence('sequenceDiagram')).toBeNull()
    // The flowchart parser must not claim it either, or the dispatcher would
    // never reach the one that can draw it.
    expect(parseMermaid(fenced(SEQUENCE))).toBeNull()
  })
})

describe('a pie fence', () => {
  beforeEach(resetBlockCache)

  it('is drawn as a chart with a legend carrying the label, the value and the share', () => {
    draw(PIE)

    expect(screen.getByTestId('markdown-mermaid-pie')).toBeTruthy()
    expect(screen.getByText('Where the minutes went')).toBeTruthy()
    expect(screen.getByText('Reading')).toBeTruthy()
    expect(screen.getByText('42  53%')).toBeTruthy()
    expect(screen.getByText('31  39%')).toBeTruthy()
    expect(screen.getByText('7  9%')).toBeTruthy()
  })

  it('takes the title from either place it can be written, and showData from neither', () => {
    expect(parsePie('pie title Adoptions\n"Dogs" : 1\n')).toEqual({
      slices: [{ label: 'Dogs', value: 1 }],
      title: 'Adoptions'
    })
    expect(parsePie('pie showData\ntitle Adoptions\n"Dogs" : 1\n')).toEqual({
      slices: [{ label: 'Dogs', value: 1 }],
      title: 'Adoptions'
    })
    expect(parsePie('pie\n"Dogs" : 1\n"Cats" : 2\n')).toEqual({
      slices: [
        { label: 'Dogs', value: 1 },
        { label: 'Cats', value: 2 }
      ]
    })
  })

  it('gives the chart a size and one arc per slice before it mounts', () => {
    const chart = parsePie('pie title Split\n"One" : 1\n"Two" : 1\n"Three" : 2\n')
    const layout = layoutPie(chart!, 17)

    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
    expect(layout.arcs).toHaveLength(3)
    expect(layout.swatches).toHaveLength(3)

    for (const arc of layout.arcs) {
      expect(arc.path.startsWith('M')).toBe(true)
    }
  })

  it('draws a single slice as a ring, because an arc from an angle to itself is nothing', () => {
    const layout = layoutPie(parsePie('pie\n"Everything" : 9\n')!, 17)

    expect(layout.arcs).toEqual([{ full: true, index: 0, path: '' }])
  })

  it('refuses a pie it cannot divide, and a half-arrived one', () => {
    expect(parsePie('pie title Nothing\n"None" : 0\n')).toBeNull()
    expect(parsePie('pie title Wrong\n"Owed" : -4\n')).toBeNull()
    expect(parsePie('pie title Half\n"Dogs" :')).toBeNull()
    expect(parsePie('pie title Empty')).toBeNull()
    expect(parsePie('pie\n"Dogs" : 1\ntitle Late\n')).toBeNull()
  })
})

describe('a diagram nothing here draws', () => {
  beforeEach(resetBlockCache)

  it('still falls back to the fenced source', () => {
    const source = [
      '```mermaid',
      'gantt',
      '  title A schedule',
      '  section One',
      '  task :a1, 2026-01-01, 3d',
      '```'
    ].join('\n')

    draw(source)

    expect(screen.queryByTestId('markdown-mermaid')).toBeNull()
    expect(screen.queryByTestId('markdown-mermaid-sequence')).toBeNull()
    expect(screen.queryByTestId('markdown-mermaid-pie')).toBeNull()
    expect(screen.getByText('gantt')).toBeTruthy()
  })

  it('does not throw on any prefix of a diagram, which is what a stream hands it', () => {
    const sources = [fenced(SEQUENCE), fenced(PIE)]

    for (const source of sources) {
      for (let at = 0; at <= source.length; at += 1) {
        const prefix = source.slice(0, at)

        expect(() => {
          parseSequence(prefix)
          parsePie(prefix)
          parseMermaid(prefix)
        }).not.toThrow()
      }
    }
  })
})
