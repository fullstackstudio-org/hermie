/**
 * The inputs `dump-markdown.ts` records the TypeScript block structure for.
 *
 * Assembled from what the Expo app's markdown tests exercise (the block,
 * render, inline, strikethrough, overflow, LaTeX and diagram suites under
 * `expo/hermie/__tests__/chat-ui/`) plus the shapes a reply most often takes.
 * Every host is an example domain and every name is made up.
 *
 * Each group becomes one file, `contract/markdown/<group>.json`. The streaming
 * group is not listed case by case: it is every prefix of a few documents, cut
 * at each line end and halfway through each line, which is what a reply looks
 * like flush after flush.
 */

export interface MarkdownCase {
  name: string
  input: string
}

const lines = (...parts: string[]): string => parts.join('\n')

export const BLOCK_CASES: MarkdownCase[] = [
  { name: 'empty', input: '' },
  { name: 'whitespace only', input: '  \n\n ' },
  { name: 'one paragraph', input: 'Just a sentence.' },
  { name: 'two paragraphs', input: 'First paragraph.\n\nSecond paragraph.' },
  { name: 'soft line break', input: 'line one\nline two' },
  { name: 'hard line break', input: 'line one  \nline two' },
  { name: 'atx headings', input: lines('# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six') },
  { name: 'heading then paragraph', input: '## Section\nBody right under it.' },
  { name: 'setext headings', input: lines('Title', '=====', '', 'Subtitle', '--------') },
  { name: 'heading with inline marks', input: '## The **bold** `code` part' },
  { name: 'unordered list', input: lines('- one', '- two', '- three') },
  { name: 'star and plus bullets', input: lines('* one', '* two', '', '+ three') },
  { name: 'ordered list', input: lines('1. first', '2. second', '3. third') },
  { name: 'ordered list from three', input: lines('3. third', '4. fourth') },
  { name: 'ordered list with parens', input: lines('1) first', '2) second') },
  { name: 'nested list', input: lines('- one', '  - nested', '  - nested two', '- two') },
  { name: 'deeply nested list', input: lines('1. top', '   - middle', '     1. bottom', '2. top again') },
  { name: 'loose list', input: lines('- one', '', '- two', '', '- three') },
  { name: 'list item with two paragraphs', input: lines('1. first line', '', '   continued paragraph', '2. second') },
  { name: 'task list', input: lines('- [ ] todo', '- [x] done', '- [X] also done', '- plain') },
  { name: 'nested task list', input: lines('- [ ] parent', '  - [x] child', '  - [ ] other child') },
  { name: 'list after paragraph', input: lines('Steps:', '- one', '- two') },
  { name: 'list then paragraph', input: lines('- one', '- two', '', 'After the list.') },
  { name: 'list item with code', input: lines('1. Run this:', '', '   ```sh', '   make test', '   ```', '2. Done') },
  { name: 'block quote', input: '> quoted' },
  { name: 'multi-line block quote', input: lines('> line one', '> line two', '>', '> second paragraph') },
  { name: 'lazy block quote', input: lines('> starts here', 'and continues lazily') },
  { name: 'nested block quote', input: lines('> outer', '>> inner') },
  { name: 'quote with list', input: lines('> Notes:', '> - one', '> - two') },
  { name: 'two quotes', input: lines('> first', '', '> second') },
  { name: 'table', input: lines('| Area | Status |', '| --- | --- |', '| Recovery | Shipped |') },
  {
    name: 'table with alignment',
    input: lines('| Left | Centre | Right | None |', '|:--|:-:|--:|---|', '| a | b | c | d |', '| e | f | g | h |')
  },
  { name: 'table without outer pipes', input: lines('a | b', '--|--', '1 | 2') },
  {
    name: 'table with inline marks',
    input: lines('| Key | Value |', '| --- | --- |', '| `id` | **bold** and [link](https://example.com) |')
  },
  { name: 'table with short row', input: lines('| a | b | c |', '| - | - | - |', '| 1 |') },
  { name: 'table with escaped pipe', input: lines('| a | b |', '| - | - |', '| x \\| y | z |') },
  {
    name: 'wide table',
    input: lines(
      '| Registrar | Domain | Renews | Autorenew | Nameservers | Owner |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Registrar One | docs.example.org | 2026-10-04 | off | ns1.example.net | Operations |'
    )
  },
  { name: 'table then prose', input: lines('| a | b |', '| - | - |', '| 1 | 2 |', '', 'Prose after.') },
  { name: 'fenced code with language', input: lines('```ts', 'const a = 1', '```') },
  { name: 'fenced code without language', input: lines('```', 'plain text', '```') },
  { name: 'tilde fence', input: lines('~~~python', 'print("hi")', '~~~') },
  { name: 'long fence', input: lines('````md', '```', 'inner', '```', '````') },
  { name: 'fence with blank lines', input: lines('```js', 'a()', '', '', 'b()', '```') },
  { name: 'fence with upper-case language', input: lines('```Python', 'x = 1', '```') },
  { name: 'fence with info string', input: lines('```js title="a.js"', 'x()', '```') },
  { name: 'fence keeps markdown literal', input: lines('```', '**not bold** [1] https://example.com', '```') },
  { name: 'indented code', input: lines('Paragraph.', '', '    indented code', '    more') },
  { name: 'thematic rules', input: lines('above', '', '---', '', '***', '', '___', '', 'below') },
  {
    name: 'mermaid fence',
    input: lines('```mermaid', 'flowchart TD', '  A[Start] --> B{Ready?}', '  B -->|yes| C[Ship]', '```')
  },
  {
    name: 'mermaid pie',
    input: lines('```mermaid', 'pie title Where the minutes went', '  "Reading" : 42', '  "Writing" : 31', '```')
  },
  { name: 'math block with dollars', input: lines('The energy:', '', '$$', 'E = mc^2', '$$') },
  { name: 'math block on one line', input: '$$\\frac{a+b}{c}$$' },
  { name: 'math block with brackets', input: lines('The energy:', '', '\\[', 'E = mc^2', '\\]') },
  { name: 'math block between paragraphs', input: lines('Before.', '', '$$x^2 + y^2 = z^2$$', '', 'After.') },
  { name: 'empty math block', input: lines('$$', '$$') },
  { name: 'empty list item', input: lines('- one', '-', '- three') },
  { name: 'empty heading', input: '##' },
  { name: 'setext underline inside a list item', input: lines('- one', '  -') },
  { name: 'fence right after a paragraph', input: lines('Run this:', '```sh', 'ls -la', '```', 'Done.') },
  { name: 'heading inside a quote', input: lines('> ## Title', '> text under it') },
  { name: 'code inside a quote', input: lines('> ```', '> quoted code', '> ```') },
  { name: 'list with large start', input: lines('10. ten', '11. eleven') },
  { name: 'mixed nested list with tasks', input: lines('1. Prepare', '   - [x] fetch', '   - [ ] build', '2. Ship') },
  { name: 'table inside a list item', input: lines('- item', '', '  | a | b |', '  | - | - |', '  | 1 | 2 |') },
  { name: 'image', input: 'Look: ![a bar chart of weekly runs](https://example.com/chart.png)' },
  { name: 'html block', input: lines('<div>', 'raw html', '</div>', '', 'After.') },
  {
    name: 'every block kind',
    input: lines(
      '# Title',
      '',
      'Body with **bold**, *italic*, ~~struck~~ and `code`.',
      '',
      '- one',
      '  - nested',
      '',
      '1. first',
      '',
      '> quoted',
      '',
      '| Area | Status |',
      '| --- | --- |',
      '| Recovery | Shipped |',
      '',
      '---',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '[link](https://example.com/x)'
    )
  }
]

export const INLINE_CASES: MarkdownCase[] = [
  { name: 'bold italic strike code', input: 'Body with **bold**, *italic*, ~~struck~~ and `code`.' },
  { name: 'underscore emphasis', input: 'Some __strong__ and _em_ words, but snake_case_name stays.' },
  { name: 'bold italic', input: '***both*** and **bold with *italic* inside**' },
  { name: 'nested strike in bold', input: '**~~dropped~~**' },
  { name: 'single tilde in a path', input: 'Run it from ~/dir and then check ~/other for the log.' },
  { name: 'single tilde alone', input: 'About ~50 rows, give or take.' },
  { name: 'strike across a lone tilde', input: '~~cd ~/old~~' },
  {
    name: 'shell prompt',
    input: lines("root@box:~# stat -c '%u:%g %n' /usr/bin/sudo", '0:0 /usr/bin/sudo', 'root@box:~#')
  },
  { name: 'stray space after opening bold', input: '** `example.nl` staat op autorenew=off**' },
  { name: 'stray space before closing bold', input: '**autorenew staat op off **' },
  { name: 'arithmetic asterisks', input: 'a ** b ** c' },
  { name: 'two stray pairs', input: 'x ** y** z ** w**' },
  { name: 'bold with code inside', input: 'Check **the `config.yml` file** first.' },
  { name: 'inline code with spaces', input: 'Spaced ``  padded  `` chip and `a`b' },
  { name: 'code with backtick inside', input: 'Use `` a`b `` here' },
  { name: 'link', input: 'Read [the docs](https://example.com/docs) now.' },
  { name: 'link with marks in label', input: '[**bold** label](https://example.com)' },
  { name: 'autolink', input: 'Go to <https://example.com/a?b=c>.' },
  { name: 'bare url', input: 'read https://example.com now' },
  { name: 'bare url with full stop', input: 'see https://example.com.' },
  { name: 'bare url in parentheses', input: '(see https://example.com)' },
  { name: 'bare url with parenthesis in path', input: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
  { name: 'bare url inside bold', input: '**see https://example.com/x**' },
  { name: 'url as link label', input: '[https://example.com](https://example.com)' },
  { name: 'citation markers', input: 'The sky is blue[1] and grass is green[2, 3].' },
  { name: 'escapes', input: 'Not \\*emphasis\\*, not \\`code\\`, a \\[bracket\\].' },
  { name: 'inline html', input: 'text <b>bold?</b> more' },
  { name: 'inline math with dollars', input: 'Einstein wrote $E = mc^2$ on a board.' },
  { name: 'inline math with parens', input: 'Einstein wrote \\(E = mc^2\\) on a board.' },
  { name: 'spaced paren math', input: 'the value \\( x^2 \\) grows' },
  { name: 'spaced dollar is not math', input: 'the value $ x^2 $ grows' },
  { name: 'prices are not math', input: 'It costs $5 and $7 today.' },
  { name: 'math in code is code', input: 'call `\\(x\\)` here' },
  { name: 'math with underscores', input: 'Sum $a_i + b_i$ over $i$.' },
  { name: 'unterminated paren math', input: 'half an expression \\( ' },
  { name: 'emphasis across soft break', input: '*one\ntwo*' },
  { name: 'trailing backslash break', input: 'one\\\ntwo' },
  { name: 'code as link label', input: '[`run`](https://example.com/run)' },
  { name: 'math inside bold', input: '**area $\\pi r^2$**' },
  { name: 'math inside a link label', input: '[see $x$ here](https://example.com)' },
  { name: 'url with a tilde', input: 'Home is https://example.com/~user/page today.' },
  { name: 'tilde in code and a strike', input: 'Use `~/bin` and ~~gone~~.' },
  { name: 'emoji in bold', input: '**🎉 done**' },
  { name: 'emphasis nesting', input: '*italic **bold** italic*' },
  { name: 'unicode text', input: 'Ünïcödé — “quotes” and emoji 🎉 stay as they are.' }
]

export const PREPROCESS_CASES: MarkdownCase[] = [
  { name: 'closed reasoning block', input: '<think>secret</think>Visible.' },
  { name: 'reasoning block between words', input: 'no<think>x</think>Hermes' },
  { name: 'unterminated reasoning block', input: 'Intro.\n\n<think>secret plan' },
  { name: 'partial reasoning tag', input: 'Intro.\n<thin' },
  { name: 'reasoning tag mid-sentence', input: 'Prose that mentions <thinking> mid-sentence.' },
  { name: 'media tag line', input: 'Here it is:\nMEDIA:/srv/out/report.pdf\nDone.' },
  { name: 'quoted media tag', input: 'MEDIA:"/srv/out/my report.pdf"' },
  { name: 'table without blank line above', input: lines('Intro line', '| a | b |', '| --- | --- |', '| 1 | 2 |') },
  {
    name: 'table without blank line below',
    input: lines('| a | b |', '| --- | --- |', '| 1 | 2 |', 'Prose right after.')
  },
  { name: 'empty fence dropped', input: lines('Before', '```', '```', 'After') },
  { name: 'url-only fence unwrapped', input: lines('```', 'https://example.com/a', '```') },
  { name: 'prose fenced by accident', input: lines('```- a bullet', 'text') },
  { name: 'unterminated fence', input: lines('Here you go:', '', '```ts', 'const a = 1') },
  { name: 'unterminated fence with nothing yet', input: lines('Here you go:', '', '```ts') },
  { name: 'unterminated fence after code', input: lines('```py', 'a = 1', '```', '', 'Then:', '', '```py', 'b = 2') },
  { name: 'fence language sanitised', input: lines('```C++ extra words', 'int x;', '```') },
  { name: 'stray emphasis in a list', input: '- ** listed**' },
  { name: 'citation marker is stripped', input: 'The sky is blue[1] and grass is green[2, 3].' },
  { name: 'root index in dollar math is kept', input: 'The cube root is $\\sqrt[3]{x}$[1] today.' },
  { name: 'root index in paren math is kept', input: 'The cube root is \\(\\sqrt[3]{x}\\)[1] today.' },
  {
    name: 'root index in display math is kept',
    input: lines('Before[1]', '', '$$', '\\sqrt[3]{x}', '$$', '', 'After[2]')
  },
  {
    name: 'root index in bracket math is kept',
    input: lines('Before[1]', '', '\\[', '\\sqrt[3]{x}', '\\]', '', 'After[2]')
  },
  { name: 'root index after an open command is kept', input: 'half an expression $x = \\sqrt[3]' },
  { name: 'citation beside math is stripped', input: 'Roots $\\sqrt[3]{x}$ are odd[1] and $y[2]$ stays.' },
  { name: 'citation after prices is stripped', input: 'It costs $5 and $7 today[1].' }
]

/** Documents whose every prefix is a case of `streaming.json`. */
export const STREAMING_DOCUMENTS: MarkdownCase[] = [
  {
    name: 'reply',
    input: lines(
      '## Plan',
      '',
      'We need **three** things:',
      '',
      '1. A table:',
      '',
      '| Step | Owner |',
      '|:--|--:|',
      '| Build | ops |',
      '',
      '2. Some code:',
      '',
      '```swift',
      'let a = 1',
      '',
      'print(a)',
      '```',
      '',
      '> Remember the ~~old~~ new rule.',
      '',
      '- [x] done',
      '- [ ] open',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      'See https://example.com/x.'
    )
  },
  {
    name: 'nested',
    input: lines(
      'Intro paragraph with `code`',
      'and a second line.',
      '- one',
      '  - two',
      '    - three',
      '',
      '  back in one',
      '- four',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      'Closing words.'
    )
  }
]

STREAMING_DOCUMENTS.push({
  name: 'summary',
  input: lines(
    'Here is **the summary** of `config.yml`:',
    '',
    '| Key | Value | Notes |',
    '|---|:-:|--:|',
    '| `port` | 8080 | default |',
    '| `host` | example.com | see [docs](https://example.com/docs) |',
    '',
    'Steps:',
    '1. Edit ~/config.yml',
    '2. Check $x^2$ first',
    '3. Restart',
    '',
    '> **Note:** the ~~old~~ path is gone.',
    '',
    '```bash',
    'echo done',
    '```'
  )
})

/** Cut points: every line end, and halfway through every line. */
export function streamingPrefixes(text: string): number[] {
  const cuts = new Set<number>()
  let start = 0

  for (const line of text.split('\n')) {
    const end = start + line.length

    if (line.length > 1) {
      cuts.add(start + Math.floor(line.length / 2))
    }

    cuts.add(end)
    cuts.add(Math.min(text.length, end + 1))
    start = end + 1
  }

  return [...cuts].filter(cut => cut > 0).sort((a, b) => a - b)
}
