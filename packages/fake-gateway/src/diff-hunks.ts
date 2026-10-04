import { PY_SPACE_CLASS, codePointLength, pyRstrip, verbatimProblem } from './verbatim'

/**
 * A unified diff as the bounded hunks of a `review.diff` request, and the patch put back together from the
 * hunks the person approved (`contract/requests/README.md` §7). A port of the gateway's `diff_hunks.py`, rule
 * for rule, so the fake refuses exactly what the gateway refuses.
 *
 * `parseDiff` reads the agent's diff of ONE file and returns the file's head (what the diff says about the
 * file: modified, new, deleted or renamed) and the hunks, ids `h1`, `h2`, ... Nothing is guessed and nothing
 * is repaired: a diff that cannot be shown as it is throws `DiffError` with a sentence for the agent.
 *
 * - bounds: at most 64 KiB of text, 200 hunks, 400 lines in a hunk, 500 characters in a line (its marker
 *   included), 200 in a hunk header;
 * - a hunk without a context line after its last change must be the LAST hunk (`git apply` pins it to the
 *   end of the file), and a hunk without any context line must start at line 0 or 1;
 * - a hunk is read by its header's counts (`@@ -a,b +c,d @@`), so a removed line that looks like `--- x` is
 *   content; counts that do not match the lines refuse the diff. Starting line numbers are not checked;
 * - every line passes the verbatim rules of README §6.2 and §7.1 (`lineProblem`): a tab is the one exception
 *   to §6.2, and the layout limits are a diff's own, counted in columns with a tab stop every 8;
 * - the line ending of the DIFF itself may be CRLF (every line, the last one aside); a CR on only some lines
 *   is content and refused;
 * - `\ No newline at end of file` is kept only in the LAST hunk, once per side, directly after the last `-`
 *   and/or `+` line of the hunk, never after a context line;
 * - a binary diff, a diff of several files, a diff without a hunk and header lines this module does not
 *   know (mode changes, copies) are refused.
 *
 * The file head is read into a structure and put back by `composePatch` from that structure and the hunks the
 * GATEWAY stored, never from the agent's own header text.
 */

export const MAX_DIFF_BYTES = 65_536
export const MAX_HUNKS = 200
export const MAX_HUNK_LINES = 400
export const MAX_LINE_CHARS = 500
export const MAX_HEADER_CHARS = 200
export const MAX_PATH_CHARS = 300
export const NO_NEWLINE = '\\ No newline at end of file'
export const REGULAR_MODE = '100644'
export const TAB_STOP = 8
export const MAX_DIFF_INDENT = 96
export const MAX_DIFF_SPACE_RUN = 32
export const MAX_DIFF_WHITESPACE = 160

/** `@@ -a,b +c,d @@` and, after a space, the section text. A count left out is 1. */
export const HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@((?: [^\n]*)?)$/
const MODE = /^[0-7]{6}$/
const INDEX = /^index [0-9a-fA-F]{4,64}\.\.[0-9a-fA-F]{4,64}(?: ([0-7]{6}))?$/
const SIMILARITY = /^(\d{1,3})%$/
const SHORT = 60
const ALL_SPACE = new RegExp(`^[${PY_SPACE_CLASS}]*$`)

/** The diff cannot be reviewed as given: the message says what to change (it is shown to the agent). */
export class DiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffError'
  }
}

export type FileKind = 'modify' | 'new' | 'delete' | 'rename'

/** What the diff says about its one file. A new or deleted file is always a regular file of mode 100644. */
export interface FileHead {
  kind: FileKind
  old: string | null
  new: string | null
  /** A rename's similarity index (percent). */
  similarity?: number
}

/** The path the person is shown: the file's own (the new path of a rename; `old_path` is the other). */
export const headPath = (head: FileHead): string => (head.kind === 'delete' ? head.old : head.new) ?? ''

/** A rename's previous path, else `null`. */
export const headOldPath = (head: FileHead): string | null => (head.kind === 'rename' ? head.old : null)

export type Anchor = 'start' | 'end' | 'both'

export interface Hunk {
  id: string
  header: string
  lines: string[]
  anchor?: Anchor
}

export interface ParsedDiff {
  head: FileHead
  hunks: Hunk[]
}

/** Whether the last line of a hunk (the no-newline marker aside) is a context line. */
export function hasTrailingContext(lines: readonly string[]): boolean {
  const body = lines.filter(line => line !== NO_NEWLINE)

  return body.length > 0 && (body[body.length - 1] as string)[0] === ' '
}

/**
 * Where `git apply` pins the hunk whatever its header says, or `null`: `start` (the old start is 0 or 1: it
 * must match at the beginning of the file), `end` (no context line after the last change: it must match at
 * the END of the file) or `both` (a whole-file hunk).
 */
export function anchorOf(header: string, lines: readonly string[]): Anchor | null {
  const match = HEADER.exec(header)
  const atStart = match !== null && Number(match[1]) <= 1
  const atEnd = !hasTrailingContext(lines)

  return atStart && atEnd ? 'both' : atStart ? 'start' : atEnd ? 'end' : null
}

const hunkOf = (id: string, header: string, lines: string[]): Hunk => {
  const anchor = anchorOf(header, lines)

  return { id, header, lines, ...(anchor ? { anchor } : {}) }
}

// ── one line ──────────────────────────────────────────────────────────────────────────────────

const hex = (ch: string): string => (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')

/**
 * Why `text`, one line of a hunk without its marker (or a header), cannot be shown as it is, or `""`. README
 * §6.2 (characters) with ONE difference for a diff: U+0009 is allowed, leading and inside the line. The
 * layout limits are a diff's own (§7.1): a tab is a fixed stop every 8 columns, a run of spaces and tabs is
 * measured in columns, the indent against 96, any other run against 32, and all of them together against 160.
 * A combining mark directly after a space or a tab, or at the start of the text, is refused. A tab counts as
 * one code point for the length of the line. Whitespace at the end of the line, a tab included, is refused.
 */
export function textProblem(text: string): string {
  const cps = [...text]
  // Every run of spaces and tabs is measured below; for the characters, a run stands in as one visible character.
  const problem = verbatimProblem(text.replace(/[ \t]+/g, 'x'))

  if (problem) {
    return problem
  }

  if (text !== pyRstrip(text)) {
    return 'whitespace at the end of a line or of the text cannot be seen'
  }

  for (const [at, ch] of cps.entries()) {
    if (/^[\p{Mn}\p{Me}]$/u.test(ch) && (at === 0 || cps[at - 1] === ' ' || cps[at - 1] === '\t')) {
      return `character U+${hex(ch)} is a combining mark after a space or at the start of the text`
    }
  }

  let column = 0
  let position = 0
  let total = 0
  let at = 0

  while (at < cps.length) {
    if (cps[at] !== ' ' && cps[at] !== '\t') {
      at += 1

      continue
    }

    const start = at

    while (at < cps.length && (cps[at] === ' ' || cps[at] === '\t')) {
      at += 1
    }

    column += start - position

    const from = column

    for (const ch of cps.slice(start, at)) {
      column = ch === '\t' ? (Math.floor(column / TAB_STOP) + 1) * TAB_STOP : column + 1
    }

    position = at
    total += column - from

    if (start === 0 && column > MAX_DIFF_INDENT) {
      return `it is indented ${column} columns (a tab is a stop every ${TAB_STOP}; at most ${MAX_DIFF_INDENT}), which can put part of it out of view; present it without padding`
    }

    if (start !== 0 && column - from > MAX_DIFF_SPACE_RUN) {
      return `it has ${column - from} columns of spaces and tabs in a row (a tab is a stop every ${TAB_STOP}; at most ${MAX_DIFF_SPACE_RUN}), which can put part of it out of view; present it without padding`
    }

    if (total > MAX_DIFF_WHITESPACE) {
      return `it has more than ${MAX_DIFF_WHITESPACE} columns of spaces and tabs in all (a tab is a stop every ${TAB_STOP}), which can put part of it out of view; present it without padding`
    }
  }

  return ''
}

/**
 * Why the hunk line `line` (marker included) cannot be shown as it is, or `""`: at most 500 code points; the
 * line is the no-newline marker or starts with a space, `+` or `-`; the rest, taken as one line of text,
 * passes `textProblem`.
 */
export function lineProblem(line: string): string {
  const length = codePointLength(line)

  if (length > MAX_LINE_CHARS) {
    return `it is ${length} characters (at most ${MAX_LINE_CHARS})`
  }

  if (line === NO_NEWLINE) {
    return ''
  }

  if (line[0] !== ' ' && line[0] !== '+' && line[0] !== '-') {
    return 'it does not start with a space, + or -'
  }

  return textProblem(line.slice(1))
}

/** Why the hunk header is not one this module shows, or `""`. */
export function headerProblem(header: string): string {
  const length = codePointLength(header)

  if (length > MAX_HEADER_CHARS) {
    return `it is ${length} characters (at most ${MAX_HEADER_CHARS})`
  }

  if (HEADER.exec(header) === null) {
    return 'it is not of the form @@ -a,b +c,d @@'
  }

  return textProblem(header)
}

/** Python's `repr` of a string, cut to a short quote. */
function short(line: string): string {
  const cut = codePointLength(line) <= SHORT ? line : `${[...line].slice(0, SHORT).join('')}...`

  return `'${JSON.stringify(cut).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`
}

// ── paths ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why `path` is not a path to name a file by, or `""`: it must be relative, without empty, `.`, `..` or `.git`
 * (any case) segments or segments that start with a space or end with a space or a dot, at most 300
 * characters, free of control characters and text that can be shown as it is.
 */
export function pathProblem(path: string): string {
  if (!path) {
    return 'it is empty'
  }

  // eslint-disable-next-line no-control-regex -- a control character in a path is the problem being named
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return 'it has a control character'
  }

  if (codePointLength(path) > MAX_PATH_CHARS) {
    return `it is ${codePointLength(path)} characters (at most ${MAX_PATH_CHARS})`
  }

  if (path.startsWith('/')) {
    return 'it is absolute: use a path relative to the repository'
  }

  const segments = path.split('/')

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return 'it has an empty, . or .. segment'
  }

  if (segments.some(segment => segment.toLowerCase() === '.git')) {
    return 'it has a .git segment'
  }

  if (segments.some(segment => segment[0] === ' ' || segment.endsWith(' ') || segment.endsWith('.'))) {
    return 'a segment starts with a space or ends with a space or a dot'
  }

  if (path.includes('\\')) {
    return 'it has a backslash'
  }

  return verbatimProblem(path)
}

/** The path a `---` or `+++` line names (`null` for `/dev/null`), without the tab and timestamp some tools append. */
function fileName(token: string, what: string): string | null {
  const name = token.split('\t', 1)[0] as string

  if (name.startsWith('"')) {
    throw new DiffError(`${what}: a quoted file name is not supported; use a plain relative path.`)
  }

  return name === '/dev/null' ? null : name
}

function checked(path: string, what: string): string {
  const problem = pathProblem(path)

  if (problem) {
    throw new DiffError(`${what} ${short(path)} cannot be used: ${problem}.`)
  }

  return path
}

// ── the head ──────────────────────────────────────────────────────────────────────────────────

interface Preamble {
  git: boolean
  oldName: string | null
  newName: string | null
  hasFiles: boolean
  newFile: boolean
  deletedFile: boolean
  similarity: number | null
  renameFrom: string | null
  renameTo: string | null
}

function mode(text: string, number: number): string {
  if (!MODE.test(text)) {
    throw new DiffError(`Line ${number}: a file mode is six octal digits (100644).`)
  }

  if (text !== REGULAR_MODE) {
    const named: Record<string, string> = {
      '120000': 'a symbolic link',
      '160000': 'a submodule (gitlink)',
      '100755': 'an executable file'
    }
    const what = named[text] ?? 'not a regular file'

    throw new DiffError(
      `Line ${number}: mode ${text} is ${what}; only regular files of mode ${REGULAR_MODE} can be reviewed.`
    )
  }

  return text
}

/** The header lines before the first hunk, and the index of that hunk's header. */
function readPreamble(lines: string[]): [Preamble, number] {
  const pre: Preamble = {
    git: false,
    oldName: null,
    newName: null,
    hasFiles: false,
    newFile: false,
    deletedFile: false,
    similarity: null,
    renameFrom: null,
    renameTo: null
  }
  let i = 0

  while (i < lines.length && !(lines[i] as string).startsWith('@@')) {
    const line = lines[i] as string
    const number = i + 1

    if (line.startsWith('diff --git ')) {
      if (pre.git || pre.hasFiles) {
        throw new DiffError('The diff names more than one file; review one file at a time (one call each).')
      }

      pre.git = true
    } else if (line.startsWith('index ')) {
      const match = INDEX.exec(line)

      if (match === null) {
        throw new DiffError(`Line ${number}: an index line looks like 'index 1234567..89abcde 100644'.`)
      }

      if (match[1] !== undefined) {
        mode(match[1], number)
      }
    } else if (line.startsWith('new file mode ')) {
      mode(line.slice('new file mode '.length), number)
      pre.newFile = true
    } else if (line.startsWith('deleted file mode ')) {
      mode(line.slice('deleted file mode '.length), number)
      pre.deletedFile = true
    } else if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      throw new DiffError(
        `Line ${number}: a change of a file's mode cannot be reviewed; only the content of regular files (mode 100644) can.`
      )
    } else if (line.startsWith('similarity index ')) {
      const match = SIMILARITY.exec(line.slice('similarity index '.length))

      if (match === null || Number(match[1]) > 100) {
        throw new DiffError(`Line ${number}: a similarity index looks like 'similarity index 90%'.`)
      }

      pre.similarity = Number(match[1])
    } else if (line.startsWith('rename from ')) {
      pre.renameFrom = checked(line.slice('rename from '.length), `Line ${number}: the path`)
    } else if (line.startsWith('rename to ')) {
      pre.renameTo = checked(line.slice('rename to '.length), `Line ${number}: the path`)
    } else if (line.startsWith('--- ')) {
      if (pre.hasFiles || !(i + 1 < lines.length && (lines[i + 1] as string).startsWith('+++ '))) {
        throw new DiffError(`Line ${number}: a '--- ' line must be followed by a '+++ ' line, once.`)
      }

      pre.oldName = fileName(line.slice(4), `Line ${number}`)
      pre.newName = fileName((lines[i + 1] as string).slice(4), `Line ${number + 1}`)
      pre.hasFiles = true
      i += 1
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      throw new DiffError('A binary diff cannot be reviewed: only text hunks can be shown to the person.')
    } else {
      throw new DiffError(
        `Line ${number} is not part of a unified diff of one file: ${short(line)}. Send the diff as it is (git diff or diff -u), without anything around it.`
      )
    }

    i += 1
  }

  return [pre, i]
}

/**
 * The `FileHead` the header lines and the agent's `path` say; refuses what contradicts. A diff without `---`
 * and `+++` lines (bare hunks) needs the agent's `path`: the person must see which file it is.
 */
function readHead(pre: Preamble, path: string | null): FileHead {
  if (path !== null) {
    checked(path, 'path')
  }

  if (!pre.hasFiles) {
    if (pre.git || pre.newFile || pre.deletedFile || pre.renameFrom || pre.renameTo) {
      throw new DiffError("The diff has file header lines but no '--- ' and '+++ ' lines.")
    }

    if (path === null) {
      throw new DiffError(
        "path is required: the diff has no '--- ' and '+++ ' lines, so say which file it changes (a relative path) or send the diff with its header lines."
      )
    }

    return { kind: 'modify', old: path, new: path }
  }

  let old = pre.oldName
  let now = pre.newName

  // git writes a/ and b/ in front of both names; strip them as a pair (or from the one that exists).
  if ((old === null || old.startsWith('a/')) && (now === null || now.startsWith('b/'))) {
    old = old ? old.slice(2) : null
    now = now ? now.slice(2) : null
  }

  for (const [name, side] of [
    [old, "'---'"],
    [now, "'+++'"]
  ] as const) {
    if (name !== null) {
      checked(name, `The ${side} path`)
    }
  }

  if (old === null && now === null) {
    throw new DiffError('The diff has /dev/null on both sides.')
  }

  let head: FileHead

  if (old === null) {
    if (pre.deletedFile || pre.renameFrom || pre.renameTo) {
      throw new DiffError('The header says the file is new but also deleted or renamed.')
    }

    head = { kind: 'new', old: null, new: now }
  } else if (now === null) {
    if (pre.newFile || pre.renameFrom || pre.renameTo) {
      throw new DiffError('The header says the file is deleted but also new or renamed.')
    }

    head = { kind: 'delete', old, new: null }
  } else if (old === now) {
    if (pre.newFile || pre.deletedFile || pre.renameFrom || pre.renameTo) {
      throw new DiffError('The header says the file is new, deleted or renamed but names one path on both sides.')
    }

    head = { kind: 'modify', old, new: now }
  } else {
    if (pre.newFile || pre.deletedFile) {
      throw new DiffError('The header says the file is renamed but also new or deleted.')
    }

    if (pre.renameFrom !== old || pre.renameTo !== now) {
      throw new DiffError(
        "The diff names two different files without 'rename from' and 'rename to' lines that say so; review one file at a time."
      )
    }

    head = { kind: 'rename', old, new: now, ...(pre.similarity === null ? {} : { similarity: pre.similarity }) }
  }

  if (path !== null && path !== headPath(head)) {
    throw new DiffError(
      `path ${short(path)} is not the file the diff changes (${short(headPath(head))}); leave path out or name that file.`
    )
  }

  return head
}

// ── the hunks ─────────────────────────────────────────────────────────────────────────────────

const count = (text: string | undefined): number => (text === undefined ? 1 : Number(text))

function checkLine(line: string, hid: string, index: number, number: number): void {
  const problem = lineProblem(line)

  if (problem) {
    throw new DiffError(
      `Hunk ${hid}, line ${index} (line ${number} of the diff) ${short(line)} cannot be shown as it is: ${problem}.`
    )
  }
}

/** The hunk whose header is `lines[i]` and the index of the line after it. */
function readHunk(lines: string[], start: number, number: number): [Hunk, number] {
  const hid = `h${number}`
  const header = lines[start] as string
  const problem = headerProblem(header)

  if (problem) {
    throw new DiffError(`Hunk ${hid} (line ${start + 1}): the header ${short(header)} cannot be shown: ${problem}.`)
  }

  const match = HEADER.exec(header) as RegExpExecArray
  let oldLeft = count(match[2])
  let newLeft = count(match[4])
  const body: string[] = []
  const marked = new Set<string>()
  let i = start + 1

  const fail = (message: string) => new DiffError(`Hunk ${hid}: ${message}`)

  /**
   * `\ No newline at end of file` says the line before it has no newline. It is allowed only after a `-` or
   * `+` line that is the last of its side in the hunk (git apply would otherwise join that line to the next
   * one in the file, invisibly), once per side; the last hunk is checked by the caller.
   */
  const checkMarker = (at: number): void => {
    if (body.length === 0 || body[body.length - 1] === NO_NEWLINE) {
      throw fail(`line ${at}: '${NO_NEWLINE}' must follow a line.`)
    }

    const side = (body[body.length - 1] as string)[0] as string

    if (side === ' ') {
      throw fail(
        `line ${at}: '${NO_NEWLINE}' after a context line is refused: show the change of the final newline as - and + lines of that line.`
      )
    }

    if ((side === '-' ? oldLeft : newLeft) > 0 || marked.has(side)) {
      throw fail(
        `line ${at}: '${NO_NEWLINE}' is allowed only once after the last ${side === '-' ? 'old (-)' : 'new (+)'} line of the hunk.`
      )
    }

    marked.add(side)
  }

  const tooLong = () => fail(`it has more than ${MAX_HUNK_LINES} lines; split the change into smaller hunks.`)

  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length) {
      throw fail(`the header counts ${count(match[2])} old and ${count(match[4])} new lines but the diff ends first.`)
    }

    let line = lines[i] as string

    if (line === '') {
      line = ' ' // an editor may have stripped the space of a blank context line
    }

    if (line === NO_NEWLINE) {
      checkMarker(i + 1)
    } else if (line[0] === ' ' && oldLeft > 0 && newLeft > 0) {
      oldLeft -= 1
      newLeft -= 1
    } else if (line[0] === '-' && oldLeft > 0) {
      oldLeft -= 1
    } else if (line[0] === '+' && newLeft > 0) {
      newLeft -= 1
    } else {
      throw fail(
        `line ${i + 1} ${short(line)} does not fit the header's counts (${count(match[2])} old and ${count(match[4])} new lines).`
      )
    }

    checkLine(line, hid, body.length + 1, i + 1)
    body.push(line)
    i += 1

    if (body.length > MAX_HUNK_LINES) {
      throw tooLong()
    }
  }

  if (i < lines.length && lines[i] === NO_NEWLINE) {
    checkMarker(i + 1)
    body.push(NO_NEWLINE)
    i += 1

    if (body.length > MAX_HUNK_LINES) {
      throw tooLong()
    }
  }

  if (body.length === 0) {
    throw fail('it has no lines.')
  }

  const first = Number(match[1])

  if (!body.some(line => line[0] === ' ') && (first > 1 || (count(match[2]) === 0 && first === 1))) {
    throw fail(
      `it has no context line and starts at line ${first}: git apply puts a hunk without context at the end of the file, not at that line, so the person would see one place and the change would land elsewhere. Include unchanged lines around the change (git diff -U3, never -U0).`
    )
  }

  return [hunkOf(hid, header, body), i]
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/**
 * The one-file unified diff `diff` as a `ParsedDiff`; `path` is the agent's name for the file (a diff of bare
 * hunks, without `---` and `+++` lines, needs it). Throws `DiffError`, the sentence to give the agent.
 */
export function parseDiff(diff: unknown, path: string | null = null): ParsedDiff {
  if (typeof diff !== 'string') {
    throw new DiffError('diff is required: a unified diff of one file, as text.')
  }

  if (LONE_SURROGATE.test(diff)) {
    throw new DiffError('The diff is not valid text (it has a lone surrogate).')
  }

  const size = Buffer.byteLength(diff, 'utf8')

  if (size > MAX_DIFF_BYTES) {
    throw new DiffError(`The diff is ${size} bytes; the limit is ${MAX_DIFF_BYTES} (64 KiB). Review a smaller change.`)
  }

  if (ALL_SPACE.test(diff)) {
    throw new DiffError('diff is required: a unified diff of one file, as text.')
  }

  let lines = diff.split('\n')

  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  if (lines.length > 1 && lines.slice(0, -1).every(line => line.endsWith('\r'))) {
    // The diff's own line ending is CRLF: take it off every line.
    lines = lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  }

  const [pre, first] = readPreamble(lines)
  const head = readHead(pre, path)
  const hunks: Hunk[] = []
  let i = first

  while (i < lines.length) {
    const line = lines[i] as string

    if (!line.startsWith('@@')) {
      if (
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && i + 1 < lines.length && (lines[i + 1] as string).startsWith('+++ '))
      ) {
        throw new DiffError('The diff names more than one file; review one file at a time (one call each).')
      }

      if (lines.slice(i).every(rest => rest === '')) {
        break
      }

      throw new DiffError(
        `Line ${i + 1} is not part of a hunk: ${short(line)}. After a hunk's last line only another hunk may follow.`
      )
    }

    if (hunks.length >= MAX_HUNKS) {
      throw new DiffError(`The diff has more than ${MAX_HUNKS} hunks; review a smaller change.`)
    }

    const previous = hunks[hunks.length - 1]

    if (previous && previous.lines.includes(NO_NEWLINE)) {
      throw new DiffError(
        `Hunk ${previous.id}: '${NO_NEWLINE}' is allowed only in the last hunk (the end of the file).`
      )
    }

    const [hunk, next] = readHunk(lines, i, hunks.length + 1)

    hunks.push(hunk)
    i = next
  }

  if (hunks.length === 0) {
    throw new DiffError('The diff has no hunk (a line starting with @@): there is nothing to review.')
  }

  for (const hunk of hunks.slice(0, -1)) {
    if (!hasTrailingContext(hunk.lines)) {
      throw new DiffError(
        `Hunk ${hunk.id}: it has no context line after its last change but another hunk follows; git apply would put it at the end of the file, where no hunk can follow. Include unchanged lines after the change (git diff -U3).`
      )
    }
  }

  if (head.kind === 'new' || head.kind === 'delete') {
    const [wanted, what] = head.kind === 'new' ? ['+', 'added (+)'] : ['-', 'removed (-)']

    for (const hunk of hunks) {
      if (hunk.lines.some(line => line[0] !== wanted && line[0] !== '\\')) {
        throw new DiffError(
          `Hunk ${hunk.id}: the file is ${head.kind === 'new' ? 'new' : 'deleted'}, so every line must be ${what}, with no context or opposite line.`
        )
      }
    }
  }

  return { head, hunks }
}

// ── the patch the person approved ─────────────────────────────────────────────────────────────

/** The header of the recomposed patch, from the stored head. */
function headLines(head: FileHead): string[] {
  const { old, new: now } = head

  if (head.kind === 'modify') {
    return [`diff --git a/${old} b/${now}`, `--- a/${old}`, `+++ b/${now}`]
  }

  if (head.kind === 'new') {
    return [`diff --git a/${now} b/${now}`, `new file mode ${REGULAR_MODE}`, '--- /dev/null', `+++ b/${now}`]
  }

  if (head.kind === 'delete') {
    return [`diff --git a/${old} b/${old}`, `deleted file mode ${REGULAR_MODE}`, `--- a/${old}`, '+++ /dev/null']
  }

  return [
    `diff --git a/${old} b/${now}`,
    ...(head.similarity === undefined ? [] : [`similarity index ${head.similarity}%`]),
    `rename from ${old}`,
    `rename to ${now}`,
    `--- a/${old}`,
    `+++ b/${now}`
  ]
}

/** `header` with its new-side start moved by `shift` lines (the net change of rejected hunks before it). */
function shifted(header: string, shift: number): string {
  if (!shift) {
    return header
  }

  const match = HEADER.exec(header)

  if (match === null) {
    return header
  }

  const start = Number(match[3]) + shift

  if (start < 0) {
    return header
  }

  const old = `${match[1]}${match[2] === undefined ? '' : `,${match[2]}`}`
  const now = `${start}${match[4] === undefined ? '' : `,${match[4]}`}`

  return `@@ -${old} +${now} @@${match[5]}`
}

/**
 * The patch of exactly the `approved` hunk ids, in order: the head the gateway stored, then each approved
 * hunk's header and lines as the gateway stored them. A rejected hunk before an approved one moves that one's
 * new-side start back by its net line change. Empty when no hunk is approved.
 */
export function composePatch(
  head: FileHead,
  hunks: readonly { id: string; header: string; lines: readonly string[] }[],
  approved: ReadonlySet<string> | readonly string[]
): string {
  const wanted = new Set(approved)
  const out: string[] = []
  let shift = 0

  for (const hunk of hunks) {
    const match = HEADER.exec(hunk.header)
    const net = match ? count(match[4]) - count(match[2]) : 0

    if (wanted.has(hunk.id)) {
      out.push(shifted(hunk.header, -shift), ...hunk.lines)
    } else {
      shift += net
    }
  }

  return out.length === 0 ? '' : `${[...headLines(head), ...out].join('\n')}\n`
}
