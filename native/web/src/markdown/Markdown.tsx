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
import { preprocessMarkdown, splitBlocks } from '@hermie/markdown'
import { memo, useMemo } from 'react'

import { MarkdownBlock } from './Block'
import './markdown.css'

export interface MarkdownProps {
  /** The Markdown source of the message, as the gateway sent it. */
  text: string
  /**
   * The gateway's base URL. A relative image source (`/api/...`) is resolved
   * against it, and an image is loaded only from this origin; any other
   * image is shown as a link. Without it no image is loaded at all.
   */
  gatewayBaseUrl?: string
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

function MarkdownView({ text, gatewayBaseUrl, className }: MarkdownProps) {
  // The same text gives the same array (a memo in `splitBlocks`), and a longer
  // text reuses the settled slices of the shorter one.
  const blocks = useMemo(() => splitBlocks(preprocessMarkdown(text)), [text])

  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((raw, index) =>
        // Whitespace-only slices render nothing, exactly as in the block model.
        raw.trim() ? <MarkdownBlock baseUrl={gatewayBaseUrl} key={blockKey(index, raw)} raw={raw} /> : null
      )}
    </div>
  )
}

export const Markdown = memo(MarkdownView)
