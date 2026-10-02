/**
 * Unified-diff parsing for `ToolItem.inlineDiff`.
 *
 * The gateway hands over a plain unified diff. Everything the card draws — the
 * +/- colour, the gutter numbers, the hunk separators — comes from this one
 * pass, so the renderer stays a dumb painter.
 */
export type DiffLineKind = 'add' | 'delete' | 'context' | 'hunk' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Line number on the left (old) side, when this line has one. */
  oldLine?: number
  /** Line number on the right (new) side, when this line has one. */
  newLine?: number
}

const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const raw of diff.split('\n')) {
    const hunk = raw.match(HUNK_RE)

    if (hunk) {
      oldLine = Number(hunk[1] ?? 0)
      newLine = Number(hunk[2] ?? 0)
      out.push({ kind: 'hunk', text: raw })

      continue
    }

    // `---`/`+++` file headers must be read before the +/- branches, or a file
    // header paints as a deleted line of code.
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity index|rename )/.test(raw)) {
      out.push({ kind: 'meta', text: raw })

      continue
    }

    if (raw.startsWith('+')) {
      out.push({ kind: 'add', newLine, text: raw.slice(1) })
      newLine += 1

      continue
    }

    if (raw.startsWith('-')) {
      out.push({ kind: 'delete', oldLine, text: raw.slice(1) })
      oldLine += 1

      continue
    }

    if (raw.startsWith('\\')) {
      // `\ No newline at end of file`
      out.push({ kind: 'meta', text: raw })

      continue
    }

    const text = raw.startsWith(' ') ? raw.slice(1) : raw

    out.push({ kind: 'context', newLine, oldLine, text })
    oldLine += 1
    newLine += 1
  }

  // A diff almost always ends on a newline; the empty tail is not a line.
  if (out.length && out[out.length - 1]?.text === '' && out[out.length - 1]?.kind === 'context') {
    out.pop()
  }

  return out
}

/** `2 lines changed` — the one-liner a collapsed file-edit card shows. */
export function summarizeDiff(diff: string): string {
  const lines = parseUnifiedDiff(diff)
  const added = lines.filter(line => line.kind === 'add').length
  const removed = lines.filter(line => line.kind === 'delete').length
  const changed = added + removed

  if (!changed) {
    return ''
  }

  return `${changed} ${changed === 1 ? 'line' : 'lines'} changed`
}
