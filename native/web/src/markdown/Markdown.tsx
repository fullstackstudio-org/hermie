/**
 * A Markdown message as React elements.
 *
 * The text goes through the shared pipeline (`preprocessMarkdown`, then
 * `splitBlocks`, then `marked.lexer` per block, inside `MarkdownBlock`) and
 * each top-level block becomes one memoised child. While a reply streams, the
 * settled blocks keep their source, their key and their elements, so a delta
 * renders the block it landed in and the blocks that appeared after it; nothing
 * before them is touched.
 *
 * No HTML is produced anywhere on the way: see `Inline.tsx` and `links.ts`.
 */
import { splitBlocks } from '@hermie/markdown/blocks'
import { preprocessMarkdown } from '@hermie/markdown/preprocess'
import { memo, useMemo } from 'react'

import { HeadingPlacementContext, MarkdownBlock, RichBlocksContext } from './Block'
import './markdown.css'
// The styles of the lazy renderers (`lazy.ts`) are in the main stylesheet, not in their chunks: a
// stylesheet that arrives late restyles the whole transcript at once, and WebKit then resizes rows
// inside the list's resize callback ("ResizeObserver loop completed with undelivered notifications").
// They are a few kilobytes of CSS, which is not first-screen JavaScript.
import './markdown-cards.css'
import './markdown-chart.css'
import './markdown-highlight.css'
import './markdown-math.css'
import './markdown-mermaid.css'

export interface MarkdownProps {
  /** The Markdown source of the message, as the gateway sent it. */
  text: string
  /**
   * The gateway's base URL. A relative image source (`/api/...`) is resolved
   * against it, and an image is loaded only from this origin; any other
   * image is shown as a link. Without it no image is loaded at all.
   */
  gatewayBaseUrl?: string
  /**
   * Levels to push the message's headings down (`#` is `h1` at 0, `h3` at 2).
   * A message in a transcript sets it so it never adds a title of its own to
   * the page. Default 0: a heading is the level it was written at.
   */
  headingOffset?: number
  /** The deepest level a heading is drawn at, after the offset (default 6). A transcript sets 3. */
  headingMax?: number
  /**
   * Whether a chart, cards and a callout are drawn (default true). What the owner typed is not: it stays as typed, so
   * their bubble sets this to false and the blocks are the code and the quote they were written as.
   */
  richBlocks?: boolean
  className?: string
}

/**
 * A small, stable hash of a block's source (FNV-1a, 32 bits). It is half of the
 * block's key, so a block whose text changed is a new element rather than an
 * update of an old one; the other half is its position.
 */
function contentHash(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

/** The React key of the block at `index` with source `raw`. */
export function blockKey(index: number, raw: string): string {
  return `${index}:${contentHash(raw)}`
}

function MarkdownView({
  text,
  gatewayBaseUrl,
  headingOffset = 0,
  headingMax = 6,
  richBlocks = true,
  className
}: MarkdownProps) {
  // The same text gives the same array (a memo in `splitBlocks`), and a longer
  // text reuses the settled slices of the shorter one.
  const blocks = useMemo(() => splitBlocks(preprocessMarkdown(text)), [text])
  const placement = useMemo(() => ({ offset: headingOffset, max: headingMax }), [headingOffset, headingMax])

  return (
    <HeadingPlacementContext.Provider value={placement}>
      <RichBlocksContext.Provider value={richBlocks}>
        <div className={className ? `md ${className}` : 'md'}>
          {blocks.map((raw, index) =>
            // Whitespace-only slices render nothing, exactly as in the block model.
            raw.trim() ? <MarkdownBlock baseUrl={gatewayBaseUrl} key={blockKey(index, raw)} raw={raw} /> : null
          )}
        </div>
      </RichBlocksContext.Provider>
    </HeadingPlacementContext.Provider>
  )
}

export const Markdown = memo(MarkdownView)
