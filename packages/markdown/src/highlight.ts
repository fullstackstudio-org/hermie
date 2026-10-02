/**
 * Syntax highlighting for fenced code, as data rather than as markup.
 *
 * `highlight.js/lib/core` plus an explicit language list — the full bundle is
 * ~190 grammars and would dominate the JS bundle for a chat client. The
 * fifteen registered here cover what agents actually paste.
 *
 * highlight.js only emits HTML, so the one string it returns is parsed back
 * into scoped spans. That parse is safe because the output grammar is tiny and
 * fixed: `<span class="hljs-…">`, `</span>`, and text with five entities
 * escaped. Going through the (semi-internal) custom-emitter API instead would
 * bind us to a shape that has already changed once between minor versions.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

// Each grammar declares its own aliases (`ts`, `sh`, `zsh`, `py`, `yml`,
// `html`, `md`, `docker`), so registering the canonical name is enough.
const LANGUAGES = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
} as const

let registered = false

function ensureRegistered(): void {
  if (registered) {
    return
  }

  for (const [name, definition] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, definition)
  }

  registered = true
}

/** One run of characters that share a highlight scope. */
export interface CodeSpan {
  text: string
  /** A highlight.js scope with the `hljs-` prefix stripped, e.g. `keyword`. */
  scope?: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#x27': "'",
  '#39': "'"
}

function unescapeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (match, name: string) => ENTITIES[name] ?? match)
}

const TAG_RE = /<span class="([^"]*)">|<\/span>/g

function parseHighlighted(html: string): CodeSpan[] {
  const spans: CodeSpan[] = []
  const stack: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  const push = (raw: string) => {
    if (!raw) {
      return
    }

    const text = unescapeHtml(raw)
    const scope = stack.at(-1)
    const previous = spans.at(-1)

    if (previous && previous.scope === scope) {
      previous.text += text

      return
    }

    spans.push(scope ? { scope, text } : { text })
  }

  TAG_RE.lastIndex = 0

  while ((match = TAG_RE.exec(html)) !== null) {
    push(html.slice(cursor, match.index))
    cursor = TAG_RE.lastIndex

    if (match[1] === undefined) {
      stack.pop()

      continue
    }

    // `class="hljs-title function_"` — the first class is the scope, the rest
    // are sub-scopes we do not colour separately.
    const first = match[1].trim().split(/\s+/, 1)[0] ?? ''

    stack.push(first.startsWith('hljs-') ? first.slice('hljs-'.length) : first)
  }

  push(html.slice(cursor))

  return spans
}

function splitLines(spans: CodeSpan[]): CodeSpan[][] {
  const lines: CodeSpan[][] = [[]]

  for (const span of spans) {
    const pieces = span.text.split('\n')

    pieces.forEach((piece, index) => {
      if (index > 0) {
        lines.push([])
      }

      if (piece) {
        lines[lines.length - 1]?.push(span.scope ? { scope: span.scope, text: piece } : { text: piece })
      }
    })
  }

  return lines
}

/** True when the fence's language tag maps to a grammar we registered. */
export function isKnownLanguage(language: string | undefined): boolean {
  ensureRegistered()

  return Boolean(language && hljs.getLanguage(language))
}

/**
 * `code` split into lines of scoped spans. An unknown or missing language, and
 * any failure inside highlight.js, degrades to unscoped text — never to an
 * empty block.
 */
export function highlightToLines(code: string, language?: string): CodeSpan[][] {
  ensureRegistered()

  if (!language || !hljs.getLanguage(language)) {
    return splitLines([{ text: code }])
  }

  try {
    const { value } = hljs.highlight(code, { ignoreIllegals: true, language })

    return splitLines(parseHighlighted(value))
  } catch {
    return splitLines([{ text: code }])
  }
}
