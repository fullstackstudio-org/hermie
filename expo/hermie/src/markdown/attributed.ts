/**
 * Markdown → a flat list of styled runs, for a surface that cannot hold views.
 *
 * ## Why this exists at all
 *
 * React Native's `Text selectable` is NOT a selection. In the pinned React
 * Native (0.81.5) `RCTParagraphComponentView` implements it as a
 * `UILongPressGestureRecognizer` that presents a `UIEditMenuInteraction`, plus
 * `canPerformAction:` answering yes to exactly one selector — `copy:` — which
 * copies `dataFromRange:NSMakeRange(0, attributedText.length)`, the WHOLE
 * paragraph. `RCTParagraphTextView`, despite the name, is a plain `UIView`
 * subclass used as the drawing surface, and its `hitTest:` returns `nil`. There
 * is no selection range in the component, so there is nothing a mouse drag could
 * move, on the new architecture or the old one.
 *
 * The only thing in UIKit that drag-selects a range of RICH text is a
 * `UITextView` over an `NSAttributedString`. Our renderer emits a tree of nested
 * `Text` and `View` — a code block is a horizontally scrolling view, a table is a
 * grid — and none of that fits inside a text view. So the reading surface keeps
 * its renderer, and "Select text" opens a second, flat presentation of the same
 * message built from these runs.
 *
 * ## The shape, and why it is flat
 *
 * A run is a slice of characters plus everything a text engine needs to draw it:
 * one BLOCK role, which decides size, weight, family and leading, and a handful
 * of inline flags that ride on top. Newlines are characters in the runs rather
 * than structure, because a `UITextView` has one string and no boxes.
 *
 * That is a deliberate loss of fidelity in exactly three places, each of which
 * would otherwise need a container:
 *
 *  - a table becomes tab-separated rows, which is what pasting one into a
 *    spreadsheet or a terminal wants anyway;
 *  - a list becomes its markers as literal text, so copying the selection
 *    carries the bullets;
 *  - an image becomes its alt text, because there is no image here to select.
 *
 * Everything else survives: heading level, bold, italic, strikethrough, inline
 * code, fenced code, block quotes and a link's target.
 *
 * ## Pure, and tested as such
 *
 * No React, no theme, no platform. The colours and the point sizes belong to
 * whoever draws the runs — the native text view on a Mac, a nested `Text` tree
 * everywhere else — and keeping them out of here is what lets one test state the
 * mapping without a renderer.
 */
import { marked, type Token, type Tokens } from './marked-compat'
import { MATH_BLOCK_TOKEN, MATH_INLINE_TOKEN, type MathToken } from './math/marked-math'
import { preprocessMarkdown } from './preprocess'

/**
 * The role a run plays, which is everything about how it is drawn except colour.
 *
 * Headings stop at three because that is where a model's own structure stops
 * mattering to a reader: `####` and below read as bold body, which is what the
 * renderer does too.
 */
export type RunBlock = 'body' | 'heading1' | 'heading2' | 'heading3' | 'code' | 'quote'

export interface SelectableRun {
  text: string
  block: RunBlock
  bold?: boolean
  italic?: boolean
  strike?: boolean
  /** An inline code span inside a sentence. A fenced block is `block: 'code'`. */
  mono?: boolean
  /** A link's target. The run's text is the label the author wrote. */
  href?: string
}

/** What an inline walk carries down; the block role comes from the caller. */
interface Inherited {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  mono?: boolean
  href?: string
}

/** A thematic break, as characters. Long enough to read as a rule, short enough to wrap nowhere. */
const RULE = '––––––––––'

function headingBlock(depth: number): RunBlock {
  if (depth <= 1) {
    return 'heading1'
  }

  if (depth === 2) {
    return 'heading2'
  }

  return 'heading3'
}

/**
 * Two runs are the same style when every field but the text agrees.
 *
 * Merging matters more than it looks: marked splits a sentence at every escape
 * and entity, so an unmerged walk produces dozens of runs for one paragraph and
 * each one crosses the bridge as its own dictionary.
 */
function sameStyle(a: SelectableRun, b: SelectableRun): boolean {
  return (
    a.block === b.block &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.mono === b.mono &&
    a.href === b.href
  )
}

class RunBuilder {
  private readonly runs: SelectableRun[] = []

  push(text: string, block: RunBlock, inherited: Inherited = {}): void {
    if (!text) {
      return
    }

    const run: SelectableRun = { block, text }

    if (inherited.bold) {
      run.bold = true
    }

    if (inherited.italic) {
      run.italic = true
    }

    if (inherited.strike) {
      run.strike = true
    }

    if (inherited.mono) {
      run.mono = true
    }

    if (inherited.href) {
      run.href = inherited.href
    }

    const last = this.runs[this.runs.length - 1]

    if (last && sameStyle(last, run)) {
      last.text += text

      return
    }

    this.runs.push(run)
  }

  /**
   * End the current block.
   *
   * A separator is only ever appended to something, so a document cannot open
   * with blank lines and a run of empty blocks cannot stack them up.
   */
  break(block: RunBlock, separator = '\n\n'): void {
    if (this.runs.length) {
      this.push(separator, block)
    }
  }

  /** Whether the text so far already ends in a line break. */
  endsWithNewline(): boolean {
    const last = this.runs[this.runs.length - 1]

    return last ? last.text.endsWith('\n') : true
  }

  done(): SelectableRun[] {
    const last = this.runs[this.runs.length - 1]

    if (last) {
      last.text = last.text.replace(/\n+$/u, '')

      if (!last.text) {
        this.runs.pop()
      }
    }

    return this.runs
  }
}

function walkInline(tokens: Token[] | undefined, block: RunBlock, inherited: Inherited, out: RunBuilder): void {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        walkInline((token as Tokens.Strong).tokens, block, { ...inherited, bold: true }, out)
        break

      case 'em':
        walkInline((token as Tokens.Em).tokens, block, { ...inherited, italic: true }, out)
        break

      case 'del':
        walkInline((token as Tokens.Del).tokens, block, { ...inherited, strike: true }, out)
        break

      case 'codespan':
        out.push((token as Tokens.Codespan).text, block, { ...inherited, mono: true })
        break

      /*
        Mathematics selects as its SOURCE, in the monospace run a code span gets.

        The drawn expression is glyphs chosen by `linear.ts` — `x²` for `x^2`,
        `(a+b)/c` for a fraction — and a reader who selects an equation out of a
        reply is nearly always taking it somewhere that speaks LaTeX. Handing
        them `x²` there would be handing them something they cannot paste back.
        The delimiters are kept for the same reason: `$x^2$` round-trips into
        another document and `x^2` does not.
      */
      case MATH_INLINE_TOKEN:
        out.push((token as MathToken).raw, block, { ...inherited, mono: true })
        break

      case 'link': {
        const link = token as Tokens.Link

        walkInline(link.tokens, block, { ...inherited, href: link.href }, out)
        break
      }

      case 'image': {
        const image = token as Tokens.Image

        // There is no image on this surface, so the alt text is the whole of
        // what can be selected — and a missing alt leaves the source, which is
        // at least something a reader can copy.
        out.push(image.text || image.href, block, inherited)
        break
      }

      case 'br':
        out.push('\n', block, inherited)
        break

      case 'escape':
        out.push((token as Tokens.Escape).text, block, inherited)
        break

      default: {
        const nested = (token as { tokens?: Token[] }).tokens

        if (nested?.length) {
          walkInline(nested, block, inherited, out)

          break
        }

        // `text`, `html` and anything a marked upgrade adds: the raw characters
        // are always better than dropping the words.
        out.push(
          (token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? '',
          block,
          inherited
        )
      }
    }
  }
}

function walkList(list: Tokens.List, block: RunBlock, out: RunBuilder): void {
  let number = Number(list.start) || 1

  for (const item of list.items) {
    const marker = list.ordered ? `${number}. ` : '• '

    number += 1

    // The marker is part of the text, deliberately: a selection that crosses a
    // list should carry its bullets, which is what a copy out of any other
    // reading app does.
    out.push(marker, block)
    walkBlocks(item.tokens, block, out, '\n')

    // The item's own last block already ended with the separator it was walked
    // with; this only covers an EMPTY item, whose marker would otherwise run
    // into the next one's.
    if (!out.endsWithNewline()) {
      out.break(block, '\n')
    }
  }

  out.break(block)
}

function walkTable(table: Tokens.Table, block: RunBlock, out: RunBuilder): void {
  const rows = [table.header, ...table.rows]

  for (const row of rows) {
    row.forEach((cell, index) => {
      if (index > 0) {
        // A tab rather than a pipe: this is the separator a spreadsheet and a
        // terminal both already understand.
        out.push('\t', block)
      }

      walkInline(cell.tokens, block, {}, out)
    })

    out.break(block, '\n')
  }

  out.break(block)
}

function walkBlocks(tokens: Token[], inheritedBlock: RunBlock, out: RunBuilder, separator = '\n\n'): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break

      case 'heading': {
        const heading = token as Tokens.Heading
        const block = inheritedBlock === 'quote' ? 'quote' : headingBlock(heading.depth)

        walkInline(heading.tokens, block, {}, out)
        out.break(block, separator)
        break
      }

      case 'code':
        // Verbatim, with its own newlines: the whole point of a fence is that
        // what is inside it is not markup, and a copy has to give it back
        // character for character. A `mermaid` fence is drawn as a picture in
        // the bubble and there is no picture on this surface, so it selects as
        // the diagram source — which is the one thing a reader could paste into
        // a tool that draws it.
        out.push((token as Tokens.Code).text, 'code')
        out.break('code', separator)
        break

      // A block expression, as the LaTeX between its delimiters. `code` rather
      // than `body` for the same reason a fence is: it is source, and it is read
      // character by character.
      case MATH_BLOCK_TOKEN:
        out.push((token as MathToken).text.trim(), 'code')
        out.break('code', separator)
        break

      case 'blockquote':
        walkBlocks((token as Tokens.Blockquote).tokens, 'quote', out, separator)
        break

      case 'list':
        walkList(token as Tokens.List, inheritedBlock, out)
        break

      case 'table':
        walkTable(token as Tokens.Table, inheritedBlock, out)
        break

      case 'hr':
        out.push(RULE, inheritedBlock)
        out.break(inheritedBlock, separator)
        break

      default: {
        const nested = (token as { tokens?: Token[] }).tokens

        if (nested?.length) {
          walkInline(nested, inheritedBlock, {}, out)
        } else {
          out.push(
            (token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? '',
            inheritedBlock
          )
        }

        out.break(inheritedBlock, separator)
      }
    }
  }
}

/**
 * Every run in one message, in reading order.
 *
 * Safe on an empty string and on a partially streamed reply — the same lexer the
 * renderer uses, over the same preprocessed text, so the two never disagree
 * about what a message SAYS even where they disagree about how to draw it.
 */
export function selectableRuns(markdown: string): SelectableRun[] {
  if (!markdown) {
    return []
  }

  const out = new RunBuilder()

  walkBlocks(marked.lexer(preprocessMarkdown(markdown)), 'body', out)

  return out.done()
}

/** The runs' characters, which is what a Select All then Copy puts on the pasteboard. */
export function runsToPlainText(runs: readonly SelectableRun[]): string {
  return runs.map(run => run.text).join('')
}
