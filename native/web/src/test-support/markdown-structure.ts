/**
 * Reads the DOM the Markdown renderer made back into the neutral block model
 * of `@hermie/markdown` (`contract/markdown/` records it), so a test can compare
 * what is on the page with what the corpus says the message contains.
 *
 * The reader is also a closed vocabulary: an element it has no meaning for is an
 * error, which is what lets the same walk prove that nothing outside the
 * allow-list was rendered.
 *
 * `expectedBlocks` brings a recorded model to what this renderer shows, in the
 * four places it differs on purpose:
 *  - a link that may not be opened has lost the link and kept its words (and
 *    the runs around it merge);
 *  - an `http(s)` link is the address as the URL parser writes it;
 *  - a table column aligned `left` is the default alignment, so it reads `null`;
 *  - the source of a math block is shown without the blank lines around it.
 */
import { isOpenableLink } from '../markdown/links'

import type { Block, Run } from '@hermie/markdown'

type Mark = NonNullable<Run['marks']>[number]

interface Style {
  marks: Mark[]
  link?: string
}

/** Tags a message may produce inside a block's words. */
const INLINE_TAGS = new Set(['STRONG', 'EM', 'DEL', 'CODE', 'BR', 'A', 'IMG', 'SPAN'])

/** Merges as the block model does: same marks and same link join. */
export function pushRun(runs: Run[], text: string, style: Style): void {
  if (!text) {
    return
  }

  const marks = [...new Set(style.marks)].sort()
  const last = runs.at(-1)

  if (last && (last.marks ?? []).join(',') === marks.join(',') && last.link === style.link) {
    last.text += text

    return
  }

  runs.push({
    text,
    ...(marks.length ? { marks } : {}),
    ...(style.link !== undefined ? { link: style.link } : {})
  })
}

function readInline(node: Node, style: Style, runs: Run[]): void {
  if (node.nodeType === 3) {
    pushRun(runs, node.textContent ?? '', style)

    return
  }

  if (!(node instanceof Element)) {
    throw new Error(`unexpected node type ${node.nodeType}`)
  }

  if (!INLINE_TAGS.has(node.tagName)) {
    throw new Error(`unexpected inline element <${node.tagName.toLowerCase()}>`)
  }

  const each = (next: Style): void => {
    for (const child of Array.from(node.childNodes)) {
      readInline(child, next, runs)
    }
  }

  switch (node.tagName) {
    case 'STRONG':
      each({ ...style, marks: [...style.marks, 'bold'] })
      break
    case 'EM':
      each({ ...style, marks: [...style.marks, 'italic'] })
      break
    case 'DEL':
      each({ ...style, marks: [...style.marks, 'strike'] })
      break
    case 'CODE':
      each({ ...style, marks: [...style.marks, node.hasAttribute('data-math') ? 'math' : 'code'] })
      break
    case 'BR':
      pushRun(runs, '\n', style)
      break
    case 'IMG':
      // The model keeps the alt text of an image and nothing else.
      pushRun(runs, node.getAttribute('alt') ?? '', style)
      break
    case 'A':
      // The link around an image is the image's address, which the model drops.
      each(node.classList.contains('md-image-link') ? style : { ...style, link: node.getAttribute('href') ?? '' })
      break
    default:
      // A span: the alt text of an image that did not load.
      each(style)
  }
}

function readRuns(parent: Element): Run[] {
  const runs: Run[] = []

  for (const child of Array.from(parent.childNodes)) {
    readInline(child, { marks: [] }, runs)
  }

  return runs
}

function readCode(element: Element): Block {
  const kind = element.getAttribute('data-kind')
  const code = element.querySelector('pre > code')
  const text = code?.textContent ?? ''

  if (kind === 'mermaid') {
    return { kind: 'mermaid', text }
  }

  if (kind === 'math') {
    return { kind: 'math', text }
  }

  const language = /(?:^|\s)language-(\S+)/.exec(code?.getAttribute('class') ?? '')?.[1]

  return { kind: 'code', ...(language ? { language } : {}), text }
}

function readTable(element: Element): Block {
  const cell = (th: Element): Run[] => readRuns(th)
  const headers = Array.from(element.querySelectorAll('thead th'))

  for (const th of headers) {
    if (th.getAttribute('scope') !== 'col') {
      throw new Error('a header cell without scope="col"')
    }
  }

  return {
    kind: 'table',
    align: headers.map(th =>
      th.classList.contains('md-align-center') ? 'center' : th.classList.contains('md-align-right') ? 'right' : null
    ),
    header: headers.map(cell),
    rows: Array.from(element.querySelectorAll('tbody tr')).map(row => Array.from(row.querySelectorAll('td')).map(cell))
  }
}

function readItem(item: Element): { checked?: boolean; blocks: Block[] } {
  const box = Array.from(item.children).find(child => child.tagName === 'INPUT')

  if (box && (box.getAttribute('type') !== 'checkbox' || !box.hasAttribute('disabled'))) {
    throw new Error('a task item whose box is not a disabled checkbox')
  }

  return {
    ...(box ? { checked: (box as HTMLInputElement).checked } : {}),
    blocks: readBlocks(item)
  }
}

/** The blocks that are the children of `parent`, in order. */
export function readBlocks(parent: Element): Block[] {
  const blocks: Block[] = []

  for (const child of Array.from(parent.children)) {
    const tag = child.tagName.toLowerCase()

    if (tag === 'input') {
      continue
    }

    if (tag === 'p' || child.classList.contains('md-item-text')) {
      blocks.push({ kind: 'paragraph', inline: readRuns(child) })
    } else if (/^h[1-6]$/.test(tag)) {
      blocks.push({ kind: 'heading', level: Number(tag.slice(1)), inline: readRuns(child) })
    } else if (tag === 'ul' || tag === 'ol') {
      blocks.push({
        kind: 'list',
        ordered: tag === 'ol',
        ...(tag === 'ol' ? { start: Number(child.getAttribute('start') ?? 1) } : {}),
        items: Array.from(child.children).map(readItem)
      })
    } else if (tag === 'blockquote') {
      blocks.push({ kind: 'quote', blocks: readBlocks(child) })
    } else if (tag === 'hr') {
      blocks.push({ kind: 'rule' })
    } else if (tag === 'pre' && child.classList.contains('md-html')) {
      blocks.push({ kind: 'html', text: child.textContent ?? '' })
    } else if (tag === 'div' && child.classList.contains('md-code')) {
      blocks.push(readCode(child))
    } else if (tag === 'div' && child.classList.contains('md-table-scroll')) {
      blocks.push(readTable(child))
    } else {
      throw new Error(`unexpected block element <${tag}>`)
    }
  }

  return blocks
}

function href(link: string): string | undefined {
  if (!isOpenableLink(link)) {
    return undefined
  }

  if (/^mailto:/i.test(link)) {
    return link
  }

  try {
    return new URL(link).href
  } catch {
    return undefined
  }
}

function mergedRuns(runs: Run[]): Run[] {
  const out: Run[] = []

  for (const run of runs) {
    const link = run.link === undefined ? undefined : href(run.link)

    pushRun(out, run.text, { marks: run.marks ?? [], ...(link !== undefined ? { link } : {}) })
  }

  return out
}

/** A recorded block, as this renderer is expected to show it. */
export function expectedBlock(block: Block): Block {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return { ...block, inline: mergedRuns(block.inline) }
    case 'list':
      return {
        ...block,
        items: block.items.map(item => ({ ...item, blocks: item.blocks.map(expectedBlock) }))
      }
    case 'quote':
      return { ...block, blocks: block.blocks.map(expectedBlock) }
    case 'table':
      return {
        ...block,
        align: block.align.map(align => (align === 'left' ? null : align)),
        header: block.header.map(mergedRuns),
        rows: block.rows.map(row => row.map(mergedRuns))
      }
    case 'math':
      return { ...block, text: block.text.trim() }
    default:
      return block
  }
}

export const expectedBlocks = (blocks: Block[]): Block[] => blocks.map(expectedBlock)
