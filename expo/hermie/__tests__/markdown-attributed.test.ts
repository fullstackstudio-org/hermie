/**
 * Markdown → the runs a real text view can drag a selection across.
 *
 * The mapping is the whole of what can be checked from here: nobody in this
 * process can drag a mouse across a `UITextView`, but whether a heading arrives
 * as a heading, whether a fenced block keeps its newlines, and whether the
 * characters a Select All would copy are the message's own words — all of that
 * is a pure function and is stated below.
 *
 * Two invariants matter more than any single case:
 *
 *  - **No block is lost.** Every word in the source appears in the runs, because
 *    a panel that quietly drops a paragraph is worse than one that draws it
 *    plainly.
 *  - **Adjacent runs of one style are merged.** Each run crosses the bridge as
 *    its own dictionary, and marked splits a sentence at every escape.
 */
import { runsToPlainText, selectableRuns } from '../src/markdown/attributed'

const blocksOf = (markdown: string) => selectableRuns(markdown).map(run => run.block)
const textOf = (markdown: string) => runsToPlainText(selectableRuns(markdown))

describe('markdown as selectable runs', () => {
  it('has nothing to say about an empty message', () => {
    expect(selectableRuns('')).toEqual([])
  })

  it('carries a heading’s level, capped at three', () => {
    expect(blocksOf('# One')).toEqual(['heading1'])
    expect(blocksOf('## Two')).toEqual(['heading2'])
    expect(blocksOf('### Three')).toEqual(['heading3'])
    // `####` and below read as bold body to a reader, which is what the renderer
    // does too.
    expect(blocksOf('#### Four')).toEqual(['heading3'])
  })

  it('keeps bold, italic and strikethrough as flags on the run', () => {
    const runs = selectableRuns('plain **bold** *italic* ~~gone~~')

    expect(runs.find(run => run.text === 'bold')).toMatchObject({ block: 'body', bold: true })
    expect(runs.find(run => run.text === 'italic')).toMatchObject({ italic: true })
    expect(runs.find(run => run.text === 'gone')).toMatchObject({ strike: true })
    // The words survive in order, syntax and all removed.
    expect(textOf('plain **bold** *italic* ~~gone~~')).toBe('plain bold italic gone')
  })

  it('tells an inline code span from a fenced block', () => {
    const inline = selectableRuns('use `npm run mac` first')
    const fenced = selectableRuns('```sh\nnpm run mac\nnpm test\n```')

    expect(inline.find(run => run.text === 'npm run mac')).toMatchObject({ block: 'body', mono: true })
    expect(fenced).toEqual([{ block: 'code', text: 'npm run mac\nnpm test' }])
  })

  it('keeps a fenced block’s own newlines, character for character', () => {
    // The whole point of a fence is that what is inside it is not markup, and a
    // copy out of the panel has to give it back exactly.
    expect(textOf('```\n  indented\n\n  after a blank\n```')).toBe('  indented\n\n  after a blank')
  })

  it('carries a link’s target and shows the author’s words', () => {
    const runs = selectableRuns('See [the notes](https://example.com/notes).')
    const link = runs.find(run => run.href)

    expect(link).toMatchObject({ href: 'https://example.com/notes', text: 'the notes' })
    expect(textOf('See [the notes](https://example.com/notes).')).toBe('See the notes.')
  })

  it('writes a list’s markers out as characters', () => {
    // A selection that crosses a list carries its bullets, which is what a copy
    // out of any other reading app does.
    expect(textOf('- one\n- two')).toBe('• one\n• two')
    expect(textOf('3. three\n4. four')).toBe('3. three\n4. four')
  })

  it('flattens a table to tab-separated rows', () => {
    // A tab is the separator a spreadsheet and a terminal both already
    // understand; a pipe is neither.
    expect(textOf('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a\tb\n1\t2')
  })

  it('marks a block quote so it can be drawn in the muted ink', () => {
    expect(blocksOf('> quoted')).toEqual(['quote'])
  })

  it('reduces an image to its alt text, because there is no image to select', () => {
    expect(textOf('![a diagram](https://example.com/d.png)')).toBe('a diagram')
  })

  it('merges adjacent runs of one style', () => {
    // marked splits this at the escape; one paragraph must not arrive as three
    // dictionaries.
    const runs = selectableRuns('a \\* b \\_ c')

    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual({ block: 'body', text: 'a * b _ c' })
  })

  it('separates blocks and opens and closes on a word', () => {
    const text = textOf('# Title\n\nFirst.\n\nSecond.')

    expect(text).toBe('Title\n\nFirst.\n\nSecond.')
    expect(text.startsWith('\n')).toBe(false)
    expect(text.endsWith('\n')).toBe(false)
  })

  it('keeps every word of a mixed message', () => {
    const source = ['# Report', '', 'A **finding**, and `a flag`.', '', '- first', '- second', '', '> a caveat'].join(
      '\n'
    )

    for (const word of ['Report', 'finding', 'a flag', 'first', 'second', 'a caveat']) {
      expect(textOf(source)).toContain(word)
    }
  })

  it('survives a half-streamed reply', () => {
    // The panel can be opened on a reply that is still arriving, so an unclosed
    // fence and a dangling emphasis must not throw.
    expect(() => selectableRuns('```ts\nconst a =')).not.toThrow()
    expect(() => selectableRuns('a **bold that never clo')).not.toThrow()
    expect(textOf('a **bold that never clo')).toContain('bold that never clo')
  })
})
