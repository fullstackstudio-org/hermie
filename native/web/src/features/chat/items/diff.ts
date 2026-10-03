/**
 * A unified diff (`ToolItem.inlineDiff`), read once into lines the view paints.
 *
 * Ported from the Expo app's `chat-ui/diff.ts` with no deliberate difference in
 * what a line is: everything the view draws (the added and removed semantics,
 * the gutter numbers, the hunk headers) comes from this one pass, so the view
 * stays a painter. `diffCounts` replaces `summarizeDiff`, whose English sentence
 * belongs in the catalogue and not here.
 */
export type DiffLineKind = 'add' | 'delete' | 'context' | 'hunk' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** The line's number on the old side, when it has one. */
  oldLine?: number
  /** The line's number on the new side, when it has one. */
  newLine?: number
}

const HUNK = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u

/** File headers. Read before the `+`/`-` branches, or `--- a/x` paints as a removed line of code. */
const META = /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity index|rename )/u

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const raw of diff.split('\n')) {
    const hunk = HUNK.exec(raw)

    if (hunk) {
      oldLine = Number(hunk[1] ?? 0)
      newLine = Number(hunk[2] ?? 0)
      out.push({ kind: 'hunk', text: raw })
      continue
    }

    if (META.test(raw) || raw.startsWith('\\')) {
      // `\ No newline at end of file` is about the line before it, not a line.
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

    out.push({ kind: 'context', oldLine, newLine, text: raw.startsWith(' ') ? raw.slice(1) : raw })
    oldLine += 1
    newLine += 1
  }

  // A diff almost always ends on a newline; the empty tail is not a line.
  const last = out[out.length - 1]

  if (last && last.kind === 'context' && last.text === '') {
    out.pop()
  }

  return out
}

/** How many lines a diff adds and removes. */
export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0

  for (const line of lines) {
    if (line.kind === 'add') {
      added += 1
    } else if (line.kind === 'delete') {
      removed += 1
    }
  }

  return { added, removed }
}
