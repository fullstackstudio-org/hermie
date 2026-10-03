/**
 * Hostile input. A message is written by an agent and by whatever the agent
 * read, so the renderer is tested as the one place text becomes elements.
 *
 * Every input is rendered and the whole result is checked against a closed
 * list: only these elements, no `on*` attribute, no `style`, no script in the
 * document, an anchor only for `http(s)` and `mailto`, an `img` only on the
 * gateway. The raw text of the attack must be on the page as text.
 *
 * The highlighting, mathematics and Mermaid chunks are loaded first, so every input is
 * drawn by the renderer that would draw it in a browser: a drawing is an `svg`
 * of a closed set of shapes and attributes, named by its source, with no link,
 * no reference, no foreign content and no animation in it.
 */
import { resetBlockCache } from '@hermie/markdown'
import { render } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { highlightRenderer, mathRenderer, mermaidRenderer } from './lazy'
import { Markdown } from './Markdown'
import { MATH_FONT, MATH_MONO_FONT } from './Math'

const GATEWAY = 'https://gw.example.test'

/** The elements the renderer may make. Everything else is a failure. */
const ALLOWED_TAGS = new Set([
  'DIV',
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'INPUT',
  'BLOCKQUOTE',
  'HR',
  'PRE',
  'CODE',
  'BUTTON',
  'SPAN',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'STRONG',
  'EM',
  'DEL',
  'BR',
  'A',
  'IMG',
  // A drawing (mathematics, a diagram). SVG elements keep their lower-case names.
  'svg',
  'g',
  'text',
  'tspan',
  'rect',
  'path',
  'line',
  'polygon',
  'circle'
])

/** The SVG elements: what they may carry, and the only values a colour attribute may have. */
const SVG_TAGS = new Set(['svg', 'g', 'text', 'tspan', 'rect', 'path', 'line', 'polygon', 'circle'])
const SVG_ATTRIBUTES = new Set([
  'class',
  'role',
  'aria-label',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'd',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor'
])
const NUMERIC_SVG_ATTRIBUTE = /^(x|y|x1|y1|x2|y2|cx|cy|r|rx|font-size|stroke-width)$/

/** The attributes the renderer may set, per element, besides `class`. */
const ALLOWED_ATTRIBUTES = new Set([
  'class',
  'href',
  'target',
  'rel',
  'title',
  'src',
  'alt',
  'loading',
  'decoding',
  'type',
  'checked',
  'disabled',
  'aria-label',
  'aria-live',
  'role',
  'scope',
  'start',
  'tabindex',
  'data-kind',
  'data-math',
  'data-drawn',
  'aria-pressed'
])

const HOSTILE: readonly [name: string, input: string][] = [
  ['script element', '<script>alert(1)</script>'],
  ['script in a sentence', 'before <script>document.body.remove()</script> after'],
  ['image with a handler', '<img src=x onerror=alert(1)>'],
  ['image with a quoted handler', '<img src="x" onerror="alert(document.cookie)">'],
  ['handler on a tag in a sentence', 'a <b onclick="alert(1)">bold</b> word'],
  ['svg with onload', '<svg onload=alert(1)><circle r="1"/></svg>'],
  ['iframe', '<iframe src="https://evil.example/" srcdoc="<script>alert(1)</script>"></iframe>'],
  ['style element', '<style>body{display:none}</style>'],
  ['base element', '<base href="https://evil.example/">'],
  ['form', '<form action="https://evil.example/"><input name=x><button>go</button></form>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['anchor with a script address in html', '<a href="javascript:alert(1)">x</a>'],
  ['html comment and cdata', '<!-- x --><![CDATA[ <script>alert(1)</script> ]]>'],
  ['script link', '[click](javascript:alert(1))'],
  ['script link in capitals', '[click](JAVASCRIPT:alert(1))'],
  ['script link in mixed case', '[click](JaVaScRiPt:alert(1))'],
  ['script link with leading space', '[click](<  javascript:alert(1)>)'],
  ['script link with a tab', '[click](<java\tscript:alert(1)>)'],
  ['script link with an entity', '[click](&#106;avascript:alert(1))'],
  ['script link with a hex entity', '[click](&#x6A;avascript:alert(1))'],
  ['script link with an entity newline', '[click](java&#x0A;script:alert(1))'],
  ['script link in angle brackets', '[click](<javascript:alert(1)>)'],
  ['script autolink', '<javascript:alert(1)>'],
  ['script link by reference', '[click][r]\n\n[r]: javascript:alert(1)'],
  ['nested link in a link label', '[a [b](javascript:alert(1))](https://example.com)'],
  ['link label that is a script link', '[[x](javascript:alert(1))](javascript:alert(2))'],
  ['link wrapped around an image', '[![x](javascript:alert(1))](javascript:alert(2))'],
  ['data link', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
  ['data link in capitals', '[click](DATA:text/html,<script>alert(1)</script>)'],
  ['vbscript link', '[click](vbscript:msgbox(1))'],
  ['file link', '[click](file:///etc/passwd)'],
  ['blob link', '[click](blob:https://gw.example.test/id)'],
  ['protocol-relative link', '[click](//evil.example/x)'],
  ['image from a script address', '![x](javascript:alert(1))'],
  ['image from a data address', '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)'],
  ['image from another origin', '![tracking pixel](https://evil.example/pixel.gif)'],
  ['image from a look-alike host', `![x](${GATEWAY}.evil.example/a.png)`],
  ['image with credentials in the address', '![x](https://user:secret@gw.example.test/a.png)'],
  ['image with a handler in its alt', '![x" onerror="alert(1)](/api/a.png)'],
  ['image with a handler in its title', '![x](/api/a.png "t\\" onerror=\\"alert(1)")'],
  ['image from a path that climbs out', '![x](/../../../evil.example/a.png)'],
  ['image from a relative path that climbs out', '![x](../../../../evil)'],
  ['image from a path with an encoded climb', '![x](/api/%2e%2e/%2e%2e/evil)'],
  ['image from a path with a backslash host', '![x](/\\evil.example/x)'],
  ['image from a path outside the prefix', `![x](${GATEWAY}/api/status)`],
  ['entities that spell markup', '&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt; &#60;b&#62; &#x3C;i&#x3E;'],
  ['handler in a heading', '# <img src=x onerror=alert(1)>'],
  ['handler in a table cell', '| a |\n| --- |\n| <img src=x onerror=alert(1)> |'],
  ['handler in a list item', '- <svg onload=alert(1)>\n- [x](javascript:alert(1))'],
  ['handler in a quote', '> <script>alert(1)</script>'],
  ['handler in emphasis', '**<img src=x onerror=alert(1)>** *<b onclick=alert(1)>x</b>*'],
  ['script in inline code', '`<script>alert(1)</script>`'],
  ['script in a fence', '```\n<script>alert(1)</script>\n```'],
  ['markup in a fence language', '```"><img src=x onerror=alert(1)>\ncode\n```'],
  ['quote and angle in a fence language', '```js" onmouseover="alert(1)\ncode\n```'],
  ['markup in a mermaid fence', '```mermaid\n<img src=x onerror=alert(1)>\n```'],
  [
    'markup in a flowchart label',
    '```mermaid\nflowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B[<script>alert(1)</script>]\n```'
  ],
  [
    'entities that spell markup in a flowchart label',
    '```mermaid\nflowchart LR\n  A["&lt;script&gt;alert(1)&lt;/script&gt;"] --> B\n```'
  ],
  ['markup in a flowchart edge label', '```mermaid\nflowchart LR\n  A -->|<a href="javascript:alert(1)">x</a>| B\n```'],
  ['a click directive in a flowchart', '```mermaid\nflowchart LR\n  A --> B\n  click A "javascript:alert(1)"\n```'],
  [
    'an init directive asking for a loose security level',
    '```mermaid\n%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  A --> B\n```'
  ],
  [
    'markup in a sequence message',
    '```mermaid\nsequenceDiagram\n  A->>B: <img src=x onerror=alert(1)>\n  Note over A: <script>alert(1)</script>\n```'
  ],
  [
    'markup in a sequence participant',
    '```mermaid\nsequenceDiagram\n  participant A as <svg onload=alert(1)>\n  A->>A: x\n```'
  ],
  [
    'markup in a pie title and label',
    '```mermaid\npie title <script>alert(1)</script>\n  "<img src=x onerror=alert(1)>" : 1\n  "b" : 2\n```'
  ],
  ['markup in a math block', '$$\n<img src=x onerror=alert(1)>\n$$'],
  ['markup in inline math', 'a $<img src=x onerror=alert(1)>$ b'],
  ['markup in a text command of a formula', '$$\n\\text{<img src=x onerror=alert(1)>}\n$$'],
  ['script in a text command of a formula', '$$\nx = \\text{<script>alert(1)</script>} + \\frac{1}{2}\n$$'],
  ['a link command in a formula', '$$\n\\href{javascript:alert(1)}{x}\n$$'],
  ['an html command in a formula', '$$\n\\htmlClass{x}{y} \\style{color:red}{z}\n$$'],
  ['markup in a roman command of inline math', 'a $\\mathrm{<b onclick=alert(1)>}$ b'],
  ['markup in a text command of inline math', 'a $x + \\text{<img src=x onerror=alert(1)>}$ b'],
  ['a closing span in a highlighted listing', '```js\nconst a = "</span><img src=x onerror=alert(1)>"\n```'],
  ['highlight markup in a listing', '```html\n<span class="hljs-keyword" onclick="alert(1)">x</span>\n```'],
  ['entities in a highlighted listing', '```js\nconst a = "&lt;script&gt;" // &amp;\n```'],
  ['markup in a task item', '- [x] <img src=x onerror=alert(1)>'],
  ['unterminated tag', '<img src=x onerror=alert(1)'],
  ['unterminated fence with markup', '```html\n<script>alert(1)</script>'],
  ['reasoning block with markup', '<think><script>alert(1)</script></think>visible']
]

beforeAll(async () => {
  await Promise.all([highlightRenderer.load(), mathRenderer.load(), mermaidRenderer.load()])
})

beforeEach(() => {
  resetBlockCache()
})

/** An `svg` and everything in it: the closed vocabulary of a drawing. */
function inspectDrawing(svg: Element): void {
  expect(svg.getAttribute('role'), 'a drawing is an image').toBe('img')
  expect(svg.getAttribute('aria-label') ?? '', 'a drawing is named by its source').not.toBe('')

  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    const tag = element.tagName

    expect(SVG_TAGS.has(tag), `<${tag}> in a drawing`).toBe(true)

    for (const attribute of Array.from(element.attributes)) {
      expect(SVG_ATTRIBUTES.has(attribute.name), `${attribute.name} on <${tag}> in a drawing`).toBe(true)

      if (attribute.name === 'class') {
        for (const name of attribute.value.split(/\s+/u)) {
          expect(name, `class on <${tag}>`).toMatch(/^md(-[a-z0-9]+)*$/)
        }
      }

      if (NUMERIC_SVG_ATTRIBUTE.test(attribute.name)) {
        expect(attribute.value, `${attribute.name} on <${tag}>`).toMatch(/^-?\d+(\.\d+)?$/)
      }
    }

    for (const name of ['fill', 'stroke']) {
      const value = element.getAttribute(name)

      if (value !== null) {
        expect(value, `${name} on <${tag}>`).toMatch(/^(currentColor|none)$/)
      }
    }

    const font = element.getAttribute('font-family')

    if (font !== null) {
      expect([MATH_FONT, MATH_MONO_FONT]).toContain(font)
    }

    for (const name of ['d', 'points', 'viewBox']) {
      const value = element.getAttribute(name)

      if (value !== null) {
        expect(value, `${name} on <${tag}>`).toMatch(/^[MLQAZ0-9., -]*$/)
      }
    }
  }
}

function inspect(root: Element, base = GATEWAY): void {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const tag = element.tagName

    expect(ALLOWED_TAGS.has(tag), `<${tag.toLowerCase()}> is not an allowed element`).toBe(true)

    // A drawing has its own, closed vocabulary (`inspectDrawing`); no handler and no style there either.
    if (element.closest('svg')) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on'), `${attribute.name} on <${tag}>`).toBe(false)
        expect(attribute.name, `<${tag}>`).not.toBe('style')
      }

      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on'), `${attribute.name} on <${tag.toLowerCase()}>`).toBe(false)
      expect(attribute.name, `<${tag.toLowerCase()}>`).not.toBe('style')
      expect(ALLOWED_ATTRIBUTES.has(attribute.name), `${attribute.name} on <${tag.toLowerCase()}>`).toBe(true)
    }

    if (tag === 'A') {
      const href = element.getAttribute('href') ?? ''

      expect(href, 'an anchor with an address that is not http(s) or mailto').toMatch(/^(https?:\/\/|mailto:)/)
      expect(element.getAttribute('target')).toBe('_blank')
      expect(element.getAttribute('rel')).toBe('noopener noreferrer')
    }

    if (tag === 'IMG') {
      expect(element.getAttribute('src') ?? '', 'an image from outside the gateway').toMatch(
        new RegExp(`^${base.replaceAll('.', '\\.')}/`)
      )
      expect(element.getAttribute('loading')).toBe('lazy')
    }

    if (tag === 'BUTTON') {
      expect(element.getAttribute('type')).toBe('button')
    }

    if (tag === 'INPUT') {
      expect(element.getAttribute('type')).toBe('checkbox')
      expect(element.hasAttribute('disabled')).toBe(true)
    }

    // Class names come from the renderer; the one that carries data from the
    // message is the language class, and only a plain token reaches it.
    for (const name of Array.from(element.classList)) {
      expect(name, `class on <${tag.toLowerCase()}>`).toMatch(
        /^(md(-[a-z]+)*|md-h[1-6]|language-[A-Za-z0-9_+#.-]{1,40})$/
      )
    }
  }

  for (const svg of Array.from(root.querySelectorAll('svg'))) {
    inspectDrawing(svg)
  }

  // Nothing from the message became a script, a frame, a style sheet, a link or reference inside a
  // drawing, or foreign content in one.
  expect(
    root.querySelector(
      'script, iframe, object, embed, style, link, meta, base, form, audio, video, foreignObject, use, image, a svg, svg a, animate, set'
    )
  ).toBeNull()
  expect(document.querySelector('script')).toBeNull()
}

describe('hostile input', () => {
  it.each(HOSTILE)('%s', (_name, input) => {
    const { container } = render(<Markdown gatewayBaseUrl={GATEWAY} text={input} />)

    inspect(container)
  })

  // Behind a prefix proxy the prefix is the gateway's whole address space: nothing may load from beside it.
  it.each(HOSTILE)('%s, behind a prefix', (_name, input) => {
    const { container } = render(<Markdown gatewayBaseUrl={`${GATEWAY}/hermes`} text={input} />)

    inspect(container, `${GATEWAY}/hermes`)
  })

  it('shows the markup of an attack as the text it is', () => {
    const { container } = render(
      <Markdown
        gatewayBaseUrl={GATEWAY}
        text={'<script>alert(1)</script>\n\nbefore <img src=x onerror=alert(1)> after'}
      />
    )

    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('draws markup inside a formula as the characters that were typed, in the drawing', () => {
    const { container } = render(
      <Markdown gatewayBaseUrl={GATEWAY} text={'$$\nx = \\text{<img src=x onerror=alert(1)>} + \\frac{1}{2}\n$$'} />
    )
    const svg = container.querySelector('svg')

    expect(svg, 'the formula is drawn').not.toBeNull()
    expect(svg?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
  })

  it.each([
    ['a flowchart', '```mermaid\nflowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B\n```'],
    ['a sequence diagram', '```mermaid\nsequenceDiagram\n  A->>B: <img src=x onerror=alert(1)>\n```'],
    ['a pie', '```mermaid\npie\n  "<img src=x onerror=alert(1)>" : 1\n  "b" : 2\n```']
  ])('draws markup in a label of %s as the characters that were typed, in the drawing', (_kind, input) => {
    const { container } = render(<Markdown gatewayBaseUrl={GATEWAY} text={input} />)
    const svg = container.querySelector('svg')

    expect(svg, 'the diagram is drawn').not.toBeNull()
    // A long label wraps into lines of their own, so the spaces are compared out.
    expect(svg?.textContent?.replace(/\s/gu, '')).toContain('<imgsrc=xonerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
  })

  it('keeps the words of a link it refuses and leaves the address out of the page', () => {
    const { container } = render(
      <Markdown
        gatewayBaseUrl={GATEWAY}
        text="Read [the report](javascript:alert(1)) and [this](data:text/plain,hi)."
      />
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('Read the report and this.')
    expect(container.innerHTML).not.toContain('javascript:')
    expect(container.innerHTML).not.toContain('data:text')
  })

  it('keeps an entity as the characters that were written, never as markup', () => {
    const { container } = render(<Markdown gatewayBaseUrl={GATEWAY} text={'&lt;b&gt;not bold&lt;/b&gt; &#60;i&#62;'} />)

    expect(container.querySelector('b, i')).toBeNull()
    expect(container.textContent).toBe('&lt;b&gt;not bold&lt;/b&gt; &#60;i&#62;')
  })

  it('does not run anything when the page is handed an attack and its anchors are clicked', () => {
    const calls: string[] = []
    const original = globalThis.alert

    globalThis.alert = (message?: unknown) => {
      calls.push(String(message))
    }

    try {
      const { container } = render(
        <Markdown
          gatewayBaseUrl={GATEWAY}
          text={
            '[a](javascript:alert(1)) <img src=x onerror=alert(2)> <a href="javascript:alert(3)">b</a> https://example.com'
          }
        />
      )

      for (const anchor of Array.from(container.querySelectorAll('a'))) {
        anchor.addEventListener('click', event => event.preventDefault())
        anchor.click()
      }

      expect(calls).toEqual([])
    } finally {
      globalThis.alert = original
    }
  })
})
