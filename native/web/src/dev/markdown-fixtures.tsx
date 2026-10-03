/**
 * Development only: one page with every kind of block and inline the Markdown
 * renderer draws, to look at in a browser and to run the accessibility checker
 * over (`markdown-fixtures.axe.test.tsx`).
 *
 *   npm run client:dev, then open /dev/markdown.html
 *
 * Nothing under `src/` outside this directory and the tests imports it, and the
 * build's only input is `index.html`, so none of it reaches `dist/`; a test
 * (`markdown-fixtures.excluded.test.ts`) keeps it that way.
 */
import { useEffect, useState } from 'react'

import { Markdown } from '../markdown/Markdown'

/** Stands in for a gateway; nothing is requested from it. */
export const FIXTURE_GATEWAY = 'http://gateway.example.test'

export interface FixtureSection {
  id: string
  title: string
  markdown: string
}

const FENCE = '```'

export const FIXTURE_SECTIONS: readonly FixtureSection[] = [
  {
    id: 'headings',
    title: 'Headings and paragraphs',
    markdown: [
      '# Heading one',
      '## Heading two',
      '### Heading three',
      '#### Heading four',
      '##### Heading five',
      '###### Heading six',
      '',
      'A paragraph with **strong**, *emphasis*, ~~strikethrough~~, `inline code` and a',
      'soft line break.  ',
      'A hard break follows that one.',
      '',
      'Links: [an https link](https://example.com/page), <https://example.com/auto>, and',
      '[an address](mailto:someone@example.com).',
      '',
      '---'
    ].join('\n')
  },
  {
    id: 'lists',
    title: 'Lists, tasks and quotes',
    markdown: [
      '- one',
      '- two',
      '  - nested',
      '    - deeper',
      '',
      '3. three',
      '4. four',
      '',
      '- [x] a finished task',
      '- [ ] an open task',
      '',
      '- a loose item',
      '',
      '  with a second paragraph',
      '',
      '> A quote',
      '>',
      '> > nested in it',
      '>',
      '> - and a list'
    ].join('\n')
  },
  {
    id: 'code',
    title: 'Code',
    markdown: [
      `${FENCE}ts`,
      'const reallyLongLine = "this line is long enough that the box has to scroll sideways instead of wrapping it"',
      '// Adds two numbers.',
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      FENCE,
      '',
      `${FENCE}python`,
      'def greet(name: str) -> str:',
      '    """Say hello."""',
      "    return f'Hello, {name}!' if name else None",
      FENCE,
      '',
      `${FENCE}diff`,
      '- removed line',
      '+ added line',
      FENCE,
      '',
      `${FENCE}`,
      'a block without a language',
      FENCE,
      '',
      `${FENCE}brainfuck`,
      'a language no grammar knows: ++++[>++<-]',
      FENCE
    ].join('\n')
  },
  {
    id: 'math',
    title: 'Mathematics',
    markdown: [
      '$$',
      String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
      '$$',
      '',
      '$$',
      String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
      '$$',
      '',
      '$$',
      String.raw`A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}, \quad f(x) = \begin{cases} 0 & x < 0 \\ \frac{1}{2} & x \ge 0 \end{cases}`,
      '$$',
      '',
      '$$',
      String.raw`\left( \frac{1}{n} \right)^n \to \sqrt[k]{\int_0^1 x^2 \, dx}`,
      '$$',
      '',
      '$$',
      String.raw`\unknowncommand{x}`,
      '$$',
      '',
      String.raw`Inline math $a^2 + b^2 = c^2$ sits in the sentence, and $\alpha_i \le \beta$ too; a matrix inline`,
      String.raw`is its source: $\begin{pmatrix} 1 \\ 2 \end{pmatrix}$.`
    ].join('\n')
  },
  {
    id: 'tables',
    title: 'Tables',
    markdown: [
      '| Name | Status | Notes |',
      '| :--- | :---: | ---: |',
      '| Recovery | Shipped | A long note that makes this column wider than the others so the table has to scroll |',
      '| Search | **Planned** | `later` |'
    ].join('\n')
  },
  {
    id: 'images',
    title: 'Images',
    markdown: [
      'On the gateway: ![a chart of weekly runs](/api/files/chart.png)',
      '',
      'Elsewhere, shown as a link: ![a remote picture](https://cdn.example.net/picture.png)',
      '',
      'Not an image at all: ![inline data](data:image/png;base64,AAAA)'
    ].join('\n')
  },
  {
    id: 'hostile',
    title: 'Input that must stay inert',
    markdown: [
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror=alert(1)> and <b onclick="alert(1)">bold</b> in a sentence.',
      '',
      '[a script link](javascript:alert(1)), [a data link](data:text/html;base64,AAAA) and',
      '[a nested one]([x](javascript:alert(1))).',
      '',
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#60;b&#62;'
    ].join('\n')
  }
]

const STREAM_TEXT = [
  '### Delta by delta',
  '',
  'A reply that arrives **a few characters** at a time:',
  '',
  '- first',
  '- second',
  ''
].join('\n')

/** Replays a short reply a few characters at a time, to watch the blocks settle. */
function StreamingDemo() {
  const [length, setLength] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setLength(current => (current >= STREAM_TEXT.length ? 0 : current + 3)), 120)

    return () => clearInterval(timer)
  }, [])

  return <Markdown gatewayBaseUrl={FIXTURE_GATEWAY} text={STREAM_TEXT.slice(0, length)} />
}

export function MarkdownFixturesPage({ streaming = false }: { streaming?: boolean }) {
  return (
    <main>
      <h1>Markdown fixtures</h1>
      {FIXTURE_SECTIONS.map(section => (
        <section aria-labelledby={`fixture-${section.id}`} key={section.id}>
          <h2 id={`fixture-${section.id}`}>{section.title}</h2>
          <Markdown gatewayBaseUrl={FIXTURE_GATEWAY} text={section.markdown} />
        </section>
      ))}
      {streaming ? (
        <section aria-labelledby="fixture-streaming">
          <h2 id="fixture-streaming">Streaming</h2>
          <StreamingDemo />
        </section>
      ) : null}
    </main>
  )
}
