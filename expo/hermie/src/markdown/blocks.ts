/**
 * Block splitting for the streaming Markdown pipeline.
 *
 * `marked.lexer` over the whole reply is the expensive part, and during
 * streaming every flush is a new string — a long reply would pay that cost
 * ~30×/s. Two caches remove it, ported from the desktop app's
 * `markdown-blocks.ts`:
 *
 *  1. Exact-string cache. The same text always yields the SAME ARRAY. That is
 *     identity, not just cost: a fresh array for unchanged text makes the
 *     renderer re-render every block under it.
 *  2. Streaming-append cache. When the new text starts with a text we parsed a
 *     moment ago, the previous blocks are reused up to a settled boundary and
 *     only the suffix is lexed.
 *
 * The boundary drops the previous parse's trailing whitespace-only blocks AND
 * its last TWO content blocks. Dropping only one is unsound: appended text can
 * retroactively merge the previous parse's last two blocks into one. The
 * trigger is a trailing setext underline — `marked` only reads `-`/`=` as an
 * underline for the paragraph above it, so a settled `"#e\n5\n-"` lexes as two
 * blocks and growing the tail collapses both into one paragraph.
 *
 * Any doubt — no prefix match, or a reconstruction that does not equal the
 * input — falls back to the full lex, i.e. exactly the uncached behaviour.
 */
import { marked } from './marked-compat'

const EXACT_CACHE_MAX = 64
const exactCache = new Map<string, string[]>()

// Streaming replies grow monotonically and only a handful stream at once. A
// tiny ring is enough; each entry holds the last parse for one growing text.
const APPEND_CACHE_MAX = 4
const APPEND_CACHE_MIN_LENGTH = 2048
const appendCache: { blocks: string[]; text: string }[] = []

function fullLex(text: string): string[] {
  const blocks = marked.lexer(text).map(token => token.raw)

  // The renderer relies on `blocks.join('') === text`; anything else means a
  // token's `raw` did not round-trip and the safe answer is one block.
  return blocks.join('') === text ? blocks : [text]
}

function remember(text: string, blocks: string[]): string[] {
  exactCache.set(text, blocks)

  if (exactCache.size > EXACT_CACHE_MAX) {
    const oldest = exactCache.keys().next()

    if (!oldest.done) {
      exactCache.delete(oldest.value)
    }
  }

  if (text.length >= APPEND_CACHE_MIN_LENGTH) {
    const index = appendCache.findIndex(entry => text.startsWith(entry.text))

    if (index !== -1) {
      appendCache.splice(index, 1)
    }

    appendCache.push({ blocks, text })

    if (appendCache.length > APPEND_CACHE_MAX) {
      appendCache.shift()
    }
  }

  return blocks
}

function settledPrefix(blocks: string[]): string[] {
  const kept = [...blocks]
  let contentDropped = 0

  while (kept.length && contentDropped < 2) {
    const last = kept.pop()

    if (last !== undefined && last.trim()) {
      contentDropped += 1
    }
  }

  return kept
}

function lexIncrementally(text: string): null | string[] {
  const entry = appendCache.find(cached => text.length > cached.text.length && text.startsWith(cached.text))

  if (!entry) {
    return null
  }

  const kept = settledPrefix(entry.blocks)
  const keptText = kept.join('')

  if (!keptText || !text.startsWith(keptText)) {
    return null
  }

  const suffix = text.slice(keptText.length)
  const tail = marked.lexer(suffix).map(token => token.raw)

  if (tail.join('') !== suffix) {
    return null
  }

  return [...kept, ...tail]
}

/**
 * Split `text` into top-level Markdown blocks, each one the exact source slice
 * it came from. Whitespace-only entries are kept so the pieces still
 * reconstruct the input; the renderer skips them.
 */
export function splitBlocks(text: string): string[] {
  if (!text) {
    return []
  }

  const cached = exactCache.get(text)

  if (cached) {
    return cached
  }

  return remember(text, lexIncrementally(text) ?? fullLex(text))
}

/** Test seam: the caches are module state, and a suite wants a clean one. */
export function resetBlockCache(): void {
  exactCache.clear()
  appendCache.length = 0
}
