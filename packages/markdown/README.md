# @hermie/markdown

The Markdown core behind Hermie: text in, a block model and layout data out,
with nothing in it that knows what a screen is.

Pure TypeScript: no DOM, no Node, no React. Its two dependencies are
[`marked`](https://github.com/markedjs/marked) (the lexer) and
[`highlight.js`](https://highlightjs.org) (core plus 15 grammars, registered
by `highlight.ts`).

## What is here and what is not

Here: the parts every renderer shares, so the Expo app, the web client and the
Swift port read a message the same way. The recorded corpus in
[`contract/markdown/`](../../contract/markdown) is made from this package, and
`src/contract.test.ts` replays it.

Not here: anything that draws. The Expo components (`Markdown`, `Block`,
`Inline`, `CodeBlock`, `Math`, `Mermaid`, ...) stay in `expo/hermie/src/markdown`,
and the web client's DOM renderers live in `native/web`. A renderer in this
repository emits no HTML string: it builds elements from the data below.

## Reading a message

```ts
import { blockModelOf, resetBlockCache } from '@hermie/markdown'

const { preprocessed, blocks } = blockModelOf(text)
```

A renderer that draws from `marked` tokens directly (the Expo app does) runs the
same three steps `blockModelOf` runs:

```ts
import { marked, preprocessMarkdown, splitBlocks } from '@hermie/markdown'

for (const raw of splitBlocks(preprocessMarkdown(text))) {
  const tokens = marked.lexer(raw)
  // draw the tokens
}
```

- `preprocessMarkdown` rewrites what the Hermes gateway sends that Markdown does
  not read as intended: reasoning blocks (hidden), unterminated fences, `MEDIA:`
  delivery tags, table spacing and stray spaces inside emphasis.
- `splitBlocks` cuts the text at top-level block boundaries, so a streaming
  message re-lexes only its last block. Slices are memoised; `resetBlockCache`
  empties the memo (tests, and any caller that must not depend on earlier calls).
- `marked` is the shared lexer instance with this repository's compatibility
  rewrites and the math extensions registered. Import it from here, never from
  `marked` directly, or those rewrites are missing.

## Public API

Everything below is exported from `@hermie/markdown`; each module is also reachable on
its own as `@hermie/markdown/<module>`.

| Module             | Exports                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `block-model`      | `blockModelOf`, types `Block`, `BlockModel`, `Mark`, `Run`                                                                                                                           |
| `blocks`           | `splitBlocks`, `resetBlockCache`                                                                                                                                                     |
| `preprocess`       | `preprocessMarkdown`, `renderMediaTags`, `mediaTagValues`, `repairStrayEmphasisSpaces`, `trimUrlTail`                                                                                |
| `marked-compat`    | `marked`, types `Token`, `Tokens`; the rewrite helpers (`withoutAmbiguousCodeRuns`, ...) only by subpath                                                                             |
| `attributed`       | `selectableRuns`, `runsToPlainText`, types `SelectableRun`, `RunBlock`                                                                                                               |
| `plain-text`       | `plainTextPreview` (one line, for list rows), `plainTextBlock` (whole text)                                                                                                          |
| `highlight`        | `highlightToLines(code, language?)` returns one `CodeSpan[]` per line, `isKnownLanguage`, type `CodeSpan`                                                                            |
| `code-theme`       | `codeScopeColor(scope, scheme)`, type `CodeScheme`                                                                                                                                   |
| `math/*`           | `parseMath` to a `MathNode` tree; `mathRuns`, `mathToPlainText`, `containsGrid`; `mathHeight`, `mathLineHeight`, `gridHeights`, `gridColumns`; `isMathToken` and the token constants |
| `mermaid/parse`    | `parseMermaid` (flowchart) to a `MermaidGraph` or `null`                                                                                                                             |
| `mermaid/layout`   | `layoutMermaid(graph, bodyFontSize)` to a `MermaidLayout` of placed nodes and edges                                                                                                  |
| `mermaid/pie`      | `parsePie` to a `PieChart` or `null`; `mermaid/pie-layout` has `layoutPie`, `formatPieValue`, `formatPieShare`                                                                       |
| `mermaid/sequence` | `parseSequence` to a `SequenceDiagram` or `null`; `mermaid/sequence-layout` has `layoutSequence`                                                                                     |
| `mermaid/labels`   | text measuring and wrapping shared by the three layouts: `diagramFontSize`, `diagramLineHeight`, `wrapToWidth`, `labelBoxWidth`, ...                                                 |

Every Mermaid parser returns `null` for source it does not recognise; the
renderer then shows the source as a code block.

### Highlighting

`highlightToLines` returns plain spans `{ text, scope? }`, one array per line.
`scope` is a highlight.js class name (`keyword`, `string`, `comment`, ...); the
colour comes from `codeScopeColor`, so a renderer chooses its own palette and
no stylesheet from highlight.js is involved. Unknown languages come back as
one unstyled span per line.

### Layout is in abstract units

The layout functions take the body font size and return coordinates and sizes in
the same unit as that font size. They do not measure real text: widths come from a per-character
estimate (`CHARACTER_EM` in `mermaid/labels`), which is what keeps them pure and
the output identical on every platform. A renderer draws the boxes and text at
the given positions and scales or scrolls the canvas to fit.

## Stability

The types above are the contract between this package and its renderers, and
the corpus pins the block model. A change that moves `contract/markdown` also
moves the Swift port's tests, so it is made on purpose: regenerate with
`npm run golden`, and follow with the native side.

## Tests

```sh
npx vitest run packages/markdown   # unit tests and the corpus replay
npm run golden:check               # the recorded corpus is current
```
