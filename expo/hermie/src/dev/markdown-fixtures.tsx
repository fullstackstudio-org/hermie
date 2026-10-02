/**
 * One diagram or one formula, in a real bubble, addressable by itself.
 *
 * `--hermieOpen gallery:dev-mermaid-sequence` lands on exactly one picture, which
 * is what makes a visual check repeatable: one launch, one screenshot, in either
 * theme (`--hermieTheme light|dark`). CONTRIBUTING.md documents the arguments.
 *
 * ## Why these live here rather than in the gallery's own registry
 *
 * The in-app gallery's section list is `SECTIONS` in
 * `features/settings/GalleryScreen.tsx`, and that file belongs to another line of
 * work. `DevGallery` already special-cases two ids of its own before falling
 * through to the gallery, so these follow the same route.
 *
 * Two consequences, because they are the cost of that choice:
 *
 *  - **These sections do not appear in Settings → Gallery.** They are reachable by
 *    name only, from a launch argument. Somebody scrolling the in-app kit will not
 *    find them, which is the trade for not touching a file this round may not.
 *  - **Their ids have to stay distinct from the gallery's own**, or one would
 *    shadow the other and a launch would show the wrong thing. Hence the `dev-`
 *    prefix on every one of them, which also says at a glance where they come
 *    from.
 *
 * The bodies are the thing under inspection, so they are written the way a model
 * writes them — including the `\(…\)` and `\[…\]` delimiters, which is how half of
 * all real LaTeX arrives.
 */

import { ScrollView, View } from 'react-native'

import { AssistantBubble } from '../chat-ui'
import type { AssistantItem } from '../chat-ui/types'
import { Text } from '../ui/primitives'

/** One fixture: an id to open it by, a caption, and the reply it draws. */
interface MarkdownFixture {
  id: string
  /**
   * What the screenshot is of.
   *
   * A developer-only caption rather than copy: it is never in a build a reader
   * can reach, so it is not in the string tables (see `no-loose-strings.test.ts`,
   * which says the same thing about a gallery caption).
   */
  caption: string
  body: string
}

const SEQUENCE = [
  '```mermaid',
  'sequenceDiagram',
  '  participant C as Client',
  '  participant G as Gateway',
  '  actor W as Worker',
  '  C->>+G: POST /run',
  '  G->>W: dispatch',
  '  W-->>G: accepted',
  '  G-->>-C: 202 Accepted',
  '```'
].join('\n')

const SEQUENCE_FRAMES = [
  '```mermaid',
  'sequenceDiagram',
  '  participant C as Client',
  '  participant G as Gateway',
  '  participant S as Store',
  '  Note over C,G: the token is checked before anything else',
  '  loop every flush',
  '    G-->>C: delta',
  '  end',
  '  alt the job finished',
  '    G->>+S: write the result',
  '    S-->>-G: stored',
  '  else it timed out',
  '    G-xC: cancelled',
  '  end',
  '  G->>G: retry once',
  '  Note right of S: kept for 30 days',
  '```'
].join('\n')

const PIE = [
  '```mermaid',
  'pie title Where the minutes went',
  '  "Reading" : 42',
  '  "Writing" : 31',
  '  "Waiting on tools" : 12',
  '  "Everything else" : 7',
  '```'
].join('\n')

const FIXTURES: readonly MarkdownFixture[] = [
  {
    body: `A request and its reply, as a picture rather than a listing.\n\n${SEQUENCE}\n\nThe dashed arrows are the replies.`,
    caption: 'Mermaid — sequenceDiagram',
    id: 'dev-mermaid-sequence'
  },
  {
    body: `Frames, notes, a self-message and an activation bar.\n\n${SEQUENCE_FRAMES}`,
    caption: 'Mermaid — sequence frames, notes and activation',
    id: 'dev-mermaid-sequence-frames'
  },
  {
    body: `How the time was spent.\n\n${PIE}`,
    caption: 'Mermaid — pie',
    id: 'dev-mermaid-pie'
  },
  {
    body: 'Einstein wrote \\(E = mc^2\\), and the ratio \\( \\frac{a}{b} \\) follows from it. Compare $x_i^2$, which is the dollar spelling of the same idea.',
    caption: 'LaTeX — inline, in both spellings',
    id: 'dev-latex-inline'
  },
  {
    body: 'The sum has a closed form:\n\n\\[\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n\\]\n\nWhich is the display spelling of `$$…$$`.',
    caption: 'LaTeX — display, bracket delimiters',
    id: 'dev-latex-display'
  },
  {
    body: 'A rotation, and the vector it acts on:\n\n$$\\begin{pmatrix} \\cos\\theta & -\\sin\\theta \\\\ \\sin\\theta & \\cos\\theta \\end{pmatrix} \\begin{bmatrix} x \\\\ y \\end{bmatrix}$$',
    caption: 'LaTeX — pmatrix and bmatrix',
    id: 'dev-latex-matrix'
  },
  {
    body: 'The step function:\n\n$$f(x) = \\begin{cases} x & \\text{if } x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}$$',
    caption: 'LaTeX — cases',
    id: 'dev-latex-cases'
  },
  {
    body: 'Two lines that line up on the relation:\n\n$$\\begin{aligned} (a+b)^2 &= a^2 + 2ab + b^2 \\\\ (a-b)^2 &= a^2 - 2ab + b^2 \\end{aligned}$$',
    caption: 'LaTeX — aligned',
    id: 'dev-latex-aligned'
  },
  {
    body: 'A fence that grows with what is inside it:\n\n$$\\left( 1 + \\frac{1}{n} \\right)^n \\to e$$',
    caption: 'LaTeX — growing fence with a script',
    id: 'dev-latex-fence'
  },
  {
    body: 'Two results, one after the other:\n\n$$x = 1 \\\\ y = 2$$',
    caption: 'LaTeX — a bare line break',
    id: 'dev-latex-lines'
  },
  {
    body: [
      'What must still fall back to its source — a diagram type nothing here draws, and an environment outside the subset.',
      '',
      '```mermaid',
      'gantt',
      '  title A schedule',
      '  section Build',
      '  compile :a1, 2026-01-01, 3d',
      '```',
      '',
      '$$\\begin{array}{cc} a & b \\end{array}$$'
    ].join('\n'),
    caption: 'Fallback — an unknown diagram and an unknown environment',
    id: 'dev-markdown-fallback'
  }
]

/** Every id these fixtures answer to, for the launch argument to name. */
export const MARKDOWN_FIXTURE_IDS: readonly string[] = FIXTURES.map(fixture => fixture.id)

export function isMarkdownFixture(section: string): boolean {
  return MARKDOWN_FIXTURE_IDS.includes(section)
}

const BASE_TS = 1_767_000_000

function itemFor(fixture: MarkdownFixture): AssistantItem {
  return {
    id: fixture.id,
    interim: false,
    kind: 'assistant',
    origin: 'history',
    seq: 1,
    status: 'complete',
    streaming: false,
    text: fixture.body,
    ts: BASE_TS,
    version: 1
  }
}

/**
 * One fixture, or `null` when the id is not one of these.
 *
 * `null` is what lets `DevGallery` fall through to the in-app gallery for every
 * other id, so neither list has to know about the other beyond its own names.
 */
export function MarkdownFixtureSection({ section }: { section: string }) {
  const fixture = FIXTURES.find(entry => entry.id === section)

  if (!fixture) {
    return null
  }

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 12, paddingTop: 12 }}
      testID={`gallery-section-${fixture.id}`}
    >
      <Text color="textMuted" style={{ marginBottom: 10 }} variant="meta">
        {fixture.caption}
      </Text>
      <View>
        <AssistantBubble item={itemFor(fixture)} presentation="full" />
      </View>
    </ScrollView>
  )
}
