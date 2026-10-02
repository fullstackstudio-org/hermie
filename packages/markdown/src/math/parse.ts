/**
 * A LaTeX subset → a tree the renderer can lay out, or `null`.
 *
 * ## Why a subset, and why `null` rather than a best effort
 *
 * KaTeX parses all of LaTeX's mathematics and draws it from bundled fonts.
 * Neither half of that survives the trip to a phone: the fonts are assets that
 * load asynchronously, and an expression whose metrics arrive a frame late
 * changes its row's height on an INVERTED list, which moves the reader by
 * exactly the correction. ADR-0020 has the measurement and the decision.
 *
 * So this parser covers what a chat agent actually writes — symbols, scripts,
 * fractions, roots, the big operators with their limits, fences that grow with
 * what is inside them, and the grid environments (`pmatrix` and its family,
 * `cases`, `aligned`) with the `&` and `\\` that give them their shape — and
 * answers `null` for everything else. `null` is the whole design: the caller shows
 * the LaTeX source in a code block, which is honest, copyable and correct.
 * Dropping an unknown command would silently change what the mathematics SAYS, and
 * a renderer that quietly says something else is worse than one that admits it
 * cannot draw.
 *
 * ## Pure, and total
 *
 * No React, no theme, no platform, and it never throws — a malformed expression
 * is a `null`, including a half-typed one, because this runs on every flush of a
 * streaming reply and the text is a prefix of an expression more often than it is
 * an expression.
 */
import {
  ACCENTS,
  BIG_OPERATORS,
  DELIMITERS,
  ENVIRONMENTS,
  FONT_COMMANDS,
  FUNCTION_NAMES,
  SPACING,
  SYMBOLS,
  TEXT_MODE_COMMANDS,
  type GridStyle
} from './symbols'

/** How a run of characters is set. `italic` is the default for a variable. */
export type MathStyle = 'italic' | 'roman' | 'bold' | 'mono'

export type MathNode =
  /** One run of characters, already resolved from whatever wrote it. */
  | { kind: 'run'; text: string; style: MathStyle }
  /** A horizontal sequence. Always present at the top, even for one atom. */
  | { kind: 'row'; items: MathNode[] }
  /** A base with a superscript, a subscript, or both. */
  | { kind: 'scripts'; base: MathNode; sup?: MathNode; sub?: MathNode }
  /**
   * A big operator with its limits.
   *
   * Separate from `scripts` because the limits go UNDER and OVER in display
   * style and beside the glyph inline — one node, two layouts, decided by the
   * renderer rather than by the parser.
   */
  | { kind: 'operator'; symbol: string; upper?: MathNode; lower?: MathNode }
  | { kind: 'frac'; numerator: MathNode; denominator: MathNode }
  | { kind: 'sqrt'; radicand: MathNode; index?: MathNode }
  /** A group inside delimiters that grow with their contents. */
  | { kind: 'fenced'; open: string; close: string; body: MathNode }
  /** A character combined onto the last glyph of its base. */
  | { kind: 'accent'; base: MathNode; combining: string }
  /** Horizontal space, in multiples of a thin space. */
  | { kind: 'space' }
  /**
   * Rows of cells: every environment, and a bare `\\` line break.
   *
   * One node for `pmatrix`, `cases`, `aligned` and the rest, because the only
   * things that differ between them are the fences and how the columns line up —
   * both of which are fields. The renderer needs columns that agree across rows,
   * so this is the one construct whose row heights it computes rather than
   * letting flexbox settle them; `metrics.ts` has that arithmetic and says why.
   */
  | { kind: 'grid'; rows: MathNode[][]; open: string; close: string; style: GridStyle }

/**
 * The longest expression this will look at.
 *
 * A guard rather than a limit anybody should reach: the parser is linear, but it
 * runs on every flush of a streaming reply, and a model that opens `$$` and then
 * writes a thousand lines of prose would otherwise be re-parsed on each one.
 */
const MAX_LENGTH = 4000

/** Nesting deeper than this is a runaway rather than an expression. */
const MAX_DEPTH = 24

/** A grid past these is a table, and a table has its own Markdown syntax. */
const MAX_ROWS = 16
const MAX_COLUMNS = 8

type Atom =
  | { type: 'char'; value: string }
  | { type: 'command'; name: string }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'sup' }
  | { type: 'sub' }
  | { type: 'ampersand' }

/**
 * Characters that end a command name.
 *
 * A LaTeX control word is a backslash and letters; a control SYMBOL is a
 * backslash and exactly one non-letter, which is how `\{`, `\\` and `\,` are
 * spelled.
 */
const LETTER_RE = /[A-Za-z]/
const DIGIT_RE = /[0-9]/

function tokenize(source: string): Atom[] | null {
  const atoms: Atom[] = []
  let at = 0

  while (at < source.length) {
    const char = source[at] as string

    if (char === '\\') {
      const next = source[at + 1]

      if (next === undefined) {
        // A trailing backslash is a half-typed command, which a streaming reply
        // produces constantly. Not renderable yet.
        return null
      }

      if (!LETTER_RE.test(next)) {
        atoms.push({ type: 'command', name: next })
        at += 2

        continue
      }

      let end = at + 1

      while (end < source.length && LETTER_RE.test(source[end] as string)) {
        end += 1
      }

      atoms.push({ type: 'command', name: source.slice(at + 1, end) })
      at = end

      continue
    }

    if (char === '{') {
      atoms.push({ type: 'open' })
      at += 1

      continue
    }

    if (char === '}') {
      atoms.push({ type: 'close' })
      at += 1

      continue
    }

    if (char === '^') {
      atoms.push({ type: 'sup' })
      at += 1

      continue
    }

    if (char === '_') {
      atoms.push({ type: 'sub' })
      at += 1

      continue
    }

    if (char === '&') {
      atoms.push({ type: 'ampersand' })
      at += 1

      continue
    }

    if (char === '%' || char === '#' || char === '$') {
      // `%` starts a comment and `#` is a macro parameter; neither belongs in a
      // chat message, and `$` inside math means the delimiters were mismatched.
      return null
    }

    atoms.push({ type: 'char', value: char })
    at += 1
  }

  return atoms
}

/**
 * Where a row stops.
 *
 * `brace` is a group's contents: it ends at the matching `}`. `cell` is one cell
 * of a grid, or one line of a display expression, and ends at the next `&`, the
 * next `\\` or the environment's `\end` as well. Both stop at a `\right`, which
 * the fence parser then reads — without that rule `\left( x \right)` cannot parse
 * at all, because the row would swallow the `\right` and fail on it.
 */
type RowStop = 'brace' | 'cell'

class Parser {
  private at = 0

  /**
   * How deep inside a `\text{…}`-family group this is.
   *
   * The one thing the parser has to know about text mode, and it earns its keep:
   * a hyphen in `\text{well-known}` is a hyphen, and a hyphen in an expression is
   * a MINUS. Depth rather than a flag, because `\text{a \textbf{b-c}}` nests.
   */
  private textDepth = 0

  /**
   * Whether the atom just returned was an upright function name.
   *
   * Read once, immediately, by `atomOrScripts` — before any script is parsed, or
   * a `\sin` inside a superscript would spill the flag onto its base.
   */
  private functionName = false

  constructor(private readonly atoms: Atom[]) {}

  /**
   * The whole input, or `null` if anything in it is unknown.
   *
   * A top-level `\\` is a line break, so the input is read as a sequence of lines
   * and becomes a centred grid when there is more than one of them. `$$x = 1 \\ y
   * = 2$$` is a thing models write constantly, and running the two lines together
   * would say something different from what was written.
   */
  parse(): MathNode | null {
    const lines: MathNode[] = []

    for (;;) {
      const line = this.row(0, 'cell')

      if (line === null) {
        return null
      }

      lines.push(trimCell(line))

      const atom = this.atoms[this.at]

      if (!atom) {
        break
      }

      if (atom.type === 'command' && atom.name === '\\') {
        this.at += 1

        if (!this.lineBreak()) {
          return null
        }

        continue
      }

      // A trailing `}`, `&` or `\end` at the top level: an unmatched delimiter,
      // or an alignment tab outside the environment that would give it meaning.
      return null
    }

    // A trailing break — `a \\` — is a line the author has not written yet, which
    // during streaming is every second flush.
    while (lines.length > 1 && isEmpty(lines[lines.length - 1] as MathNode)) {
      lines.pop()
    }

    if (lines.length === 1) {
      return lines[0] as MathNode
    }

    if (lines.length > MAX_ROWS) {
      return null
    }

    return { kind: 'grid', rows: lines.map(line => [line]), open: '', close: '', style: 'gathered' }
  }

  /**
   * The optional `[6pt]` after a line break, which this renderer refuses.
   *
   * Refused rather than dropped, because dropping it means reading `\\[x]` — a
   * break followed by a bracketed term — as a break followed by nothing, and the
   * two are indistinguishable at this level. A break with a measurement on it is
   * rare in a chat message; a wrong expression is not worth the difference.
   */
  private lineBreak(): boolean {
    const next = this.atoms[this.at]

    return !(next?.type === 'char' && next.value === '[')
  }

  /** Everything up to the end of the input or the next thing `stop` names. */
  private row(depth: number, stop: RowStop = 'brace'): MathNode | null {
    if (depth > MAX_DEPTH) {
      return null
    }

    const items: MathNode[] = []

    while (this.at < this.atoms.length) {
      const atom = this.atoms[this.at] as Atom

      if (atom.type === 'close') {
        break
      }

      // Left unconsumed for `fenced()` to read. A `\right` with no `\left` ends
      // the row here too, and the caller then finds an atom it cannot use.
      if (atom.type === 'command' && atom.name === 'right') {
        break
      }

      if (stop === 'cell' && atom.type === 'ampersand') {
        break
      }

      if (stop === 'cell' && atom.type === 'command' && (atom.name === '\\' || atom.name === 'end')) {
        break
      }

      const node = this.atomOrScripts(depth)

      if (node === null) {
        return null
      }

      items.push(node)
    }

    return { kind: 'row', items: merged(items) }
  }

  /**
   * One atom, plus any scripts hanging off it.
   *
   * Both orders are accepted — `x_i^2` and `x^2_i` mean the same thing — and a
   * repeated script (`x^2^3`) is a genuine LaTeX error rather than something to
   * guess at, so it is a `null`.
   */
  private atomOrScripts(depth: number): MathNode | null {
    const base = this.atom(depth)
    // Read now, not after the scripts: `x^{\sin}` would otherwise leave the flag
    // standing and space the `x`.
    const spaced = this.functionName

    this.functionName = false

    if (base === null) {
      return null
    }

    let sup: MathNode | undefined
    let sub: MathNode | undefined

    for (;;) {
      const atom = this.atoms[this.at]

      if (atom?.type === 'sup') {
        if (sup) {
          return null
        }

        this.at += 1
        const parsed = this.atom(depth + 1)

        if (parsed === null) {
          return null
        }

        sup = parsed

        continue
      }

      if (atom?.type === 'sub') {
        if (sub) {
          return null
        }

        this.at += 1
        const parsed = this.atom(depth + 1)

        if (parsed === null) {
          return null
        }

        sub = parsed

        continue
      }

      break
    }

    if (!sup && !sub) {
      if (spaced) {
        this.skipSpaces()

        return followed(base)
      }

      return base
    }

    // A big operator keeps its own node so the renderer can put the limits
    // under and over it rather than beside it.
    if (base.kind === 'operator') {
      return {
        kind: 'operator',
        symbol: base.symbol,
        ...(sup ? { upper: sup } : {}),
        ...(sub ? { lower: sub } : {})
      }
    }

    const scripted: MathNode = { kind: 'scripts', base, ...(sup ? { sup } : {}), ...(sub ? { sub } : {}) }

    // The space goes AFTER the scripts, which is the whole reason it is added
    // here rather than beside the name: `\log_2 n` is `log₂ n`, not `log ₂n`.
    if (spaced) {
      this.skipSpaces()

      return followed(scripted)
    }

    return scripted
  }

  /**
   * Swallow the whitespace after a function name, if the author wrote any.
   *
   * `\sin x` is how everybody spells it, and this tokenizer keeps the space
   * between two atoms rather than collapsing it the way LaTeX does. Adding a thin
   * space beside one that is already there would set `sin  x` with a visible
   * double gap, so the ordinary space is consumed and the thin one replaces it —
   * which is what LaTeX draws for both spellings.
   */
  private skipSpaces(): void {
    for (;;) {
      const atom = this.atoms[this.at]

      if (atom?.type !== 'char' || !/\s/u.test(atom.value)) {
        return
      }

      this.at += 1
    }
  }

  /** A group, a command, or a single character. */
  private atom(depth: number): MathNode | null {
    if (depth > MAX_DEPTH) {
      return null
    }

    const atom = this.atoms[this.at]

    if (!atom) {
      // A script with nothing after it: `x^`. Half-typed rather than wrong.
      return null
    }

    if (atom.type === 'open') {
      this.at += 1
      const body = this.row(depth + 1)

      if (body === null || this.atoms[this.at]?.type !== 'close') {
        return null
      }

      this.at += 1

      return body
    }

    if (atom.type === 'close' || atom.type === 'sup' || atom.type === 'sub' || atom.type === 'ampersand') {
      // An `&` reaching here is an alignment tab outside any environment — a
      // grid's cells are read by `environment()`, which consumes its own — and an
      // alignment tab with nothing to align to says nothing this can draw.
      return null
    }

    if (atom.type === 'char') {
      this.at += 1

      const value = this.textDepth ? atom.value : mathematical(atom.value)

      return { kind: 'run', text: value, style: styleOf(value) }
    }

    return this.command(atom.name, depth)
  }

  private command(name: string, depth: number): MathNode | null {
    this.at += 1

    if (SPACING.has(name)) {
      return { kind: 'space' }
    }

    const symbol = SYMBOLS[name]

    if (symbol !== undefined) {
      return { kind: 'run', text: symbol, style: 'roman' }
    }

    const big = BIG_OPERATORS[name]

    if (big !== undefined) {
      return { kind: 'operator', symbol: big }
    }

    if (FUNCTION_NAMES.has(name)) {
      // A function name is upright, and it is followed by a thin space: `\sin x`
      // is `sin x` and not `sinx`. `atomOrScripts` adds the space once it knows
      // whether a subscript came between the two.
      this.functionName = true

      return { kind: 'run', text: name, style: 'roman' }
    }

    const font = FONT_COMMANDS[name]

    if (font !== undefined) {
      // Inside a text-mode group a hyphen stays a hyphen. `\mathrm` and its
      // family are math mode and are deliberately NOT in that set: `\mathrm{-}`
      // is still a minus.
      const textMode = TEXT_MODE_COMMANDS.has(name)

      if (textMode) {
        this.textDepth += 1
      }

      const body = this.atom(depth + 1)

      if (textMode) {
        this.textDepth -= 1
      }

      return body === null ? null : restyle(body, font)
    }

    const accent = ACCENTS[name]

    if (accent !== undefined) {
      const body = this.atom(depth + 1)

      return body === null ? null : { kind: 'accent', base: body, combining: accent }
    }

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const numerator = this.atom(depth + 1)
      const denominator = numerator === null ? null : this.atom(depth + 1)

      return numerator === null || denominator === null ? null : { kind: 'frac', numerator, denominator }
    }

    if (name === 'sqrt') {
      const index = this.optionalArgument(depth)

      if (index === null) {
        return null
      }

      const radicand = this.atom(depth + 1)

      return radicand === null ? null : { kind: 'sqrt', radicand, ...(index ? { index } : {}) }
    }

    if (name === 'left') {
      return this.fenced(depth)
    }

    // A `\right` reached here has no `\left`: `row()` leaves one unconsumed for
    // `fenced()`, so the only way to arrive here is without an opening fence.
    if (name === 'right') {
      return null
    }

    if (name === 'begin') {
      return this.environment(depth)
    }

    // An `\end` with no `\begin`, for the same reason as `\right`.
    if (name === 'end') {
      return null
    }

    const delimiter = DELIMITERS[name]

    if (delimiter !== undefined) {
      return { kind: 'run', text: delimiter, style: 'roman' }
    }

    // An unknown command. Dropping it would silently change what the mathematics
    // says and printing it literally would put `\mathbb` in the middle of an
    // equation, so the whole expression falls back to its source instead.
    return null
  }

  /**
   * `\begin{pmatrix} … \end{pmatrix}` and its family.
   *
   * The body is read as cells: `&` ends a cell, `\\` ends a row, and `\end` ends
   * the grid. A missing `\end` is a `null` rather than a guess, which is what a
   * half-streamed environment needs — and `\end{bmatrix}` closing a `pmatrix` is a
   * `null` too, because the fences the reader would see are not the ones the
   * author asked for.
   */
  private environment(depth: number): MathNode | null {
    const name = this.environmentName()
    const environment = name === null ? undefined : ENVIRONMENTS[name]

    if (!environment) {
      return null
    }

    const rows: MathNode[][] = []
    let cells: MathNode[] = []

    for (;;) {
      const cell = this.row(depth + 1, 'cell')

      if (cell === null) {
        return null
      }

      cells.push(trimCell(cell))

      const atom = this.atoms[this.at]

      // The end of the input with no `\end`: still arriving.
      if (!atom) {
        return null
      }

      if (atom.type === 'ampersand') {
        this.at += 1

        if (cells.length > MAX_COLUMNS) {
          return null
        }

        continue
      }

      if (atom.type === 'command' && atom.name === '\\') {
        this.at += 1

        if (!this.lineBreak()) {
          return null
        }

        rows.push(cells)
        cells = []

        if (rows.length > MAX_ROWS) {
          return null
        }

        continue
      }

      if (atom.type === 'command' && atom.name === 'end') {
        this.at += 1

        if (this.environmentName() !== name) {
          return null
        }

        rows.push(cells)
        break
      }

      // A `}` with no `{`, which the cell parser left behind.
      return null
    }

    // A trailing `\\` before the `\end` is idiomatic LaTeX and means nothing, so
    // the empty row it produces is dropped rather than drawn as a blank line.
    while (rows.length > 1 && (rows[rows.length - 1] as MathNode[]).every(isEmpty)) {
      rows.pop()
    }

    if (!rows.length || rows.every(row => row.every(isEmpty))) {
      return null
    }

    return { kind: 'grid', rows, open: environment.open, close: environment.close, style: environment.style }
  }

  /**
   * The `{pmatrix}` after a `\begin` or an `\end`.
   *
   * Letters and a star, which is the whole of what an environment name can be
   * here. Anything else — a nested group, a number, an option in brackets — is a
   * name this renderer has no table entry for anyway.
   */
  private environmentName(): string | null {
    if (this.atoms[this.at]?.type !== 'open') {
      return null
    }

    this.at += 1
    let name = ''

    for (;;) {
      const atom = this.atoms[this.at]

      if (!atom) {
        return null
      }

      if (atom.type === 'close') {
        this.at += 1

        return name || null
      }

      if (atom.type !== 'char' || !/[A-Za-z*]/u.test(atom.value)) {
        return null
      }

      name += atom.value
      this.at += 1
    }
  }

  /**
   * `\sqrt[3]{x}` — the one optional argument in the supported subset.
   *
   * Three answers, which is why it is not a `MathNode | null`: a node when there
   * was one, `undefined` when there was no bracket, and `null` when a bracket
   * opened and did not close.
   */
  private optionalArgument(depth: number): MathNode | null | undefined {
    const atom = this.atoms[this.at]

    if (atom?.type !== 'char' || atom.value !== '[') {
      return undefined
    }

    this.at += 1
    const items: MathNode[] = []

    for (;;) {
      const next = this.atoms[this.at]

      if (!next) {
        return null
      }

      if (next.type === 'char' && next.value === ']') {
        this.at += 1

        return { kind: 'row', items: merged(items) }
      }

      const node = this.atomOrScripts(depth + 1)

      if (node === null) {
        return null
      }

      items.push(node)
    }
  }

  /** `\left( … \right)`, with the two delimiters the pair names. */
  private fenced(depth: number): MathNode | null {
    const open = this.delimiter()

    if (open === null) {
      return null
    }

    const body = this.row(depth + 1)

    if (body === null) {
      return null
    }

    const closer = this.atoms[this.at]

    if (closer?.type !== 'command' || closer.name !== 'right') {
      return null
    }

    this.at += 1
    const close = this.delimiter()

    return close === null ? null : { kind: 'fenced', open, close, body }
  }

  /** The delimiter after a `\left` or a `\right`, as the character it draws. */
  private delimiter(): string | null {
    const atom = this.atoms[this.at]

    if (!atom) {
      return null
    }

    if (atom.type === 'char') {
      if (!'()[]|./'.includes(atom.value)) {
        return null
      }

      this.at += 1

      return atom.value === '.' ? '' : atom.value
    }

    if (atom.type === 'command') {
      const delimiter = DELIMITERS[atom.name]

      if (delimiter === undefined) {
        return null
      }

      this.at += 1

      return delimiter
    }

    if (atom.type === 'open') {
      this.at += 1

      return '{'
    }

    if (atom.type === 'close') {
      this.at += 1

      return '}'
    }

    return null
  }
}

/**
 * How one character is set when nothing said otherwise.
 *
 * A letter is a variable and variables are italic; a digit, an operator and a
 * bracket are not. That is the one typographic rule in mathematics that carries
 * meaning rather than style, which is why it is applied at the character and not
 * left to the renderer.
 */
function styleOf(char: string): MathStyle {
  return LETTER_RE.test(char) ? 'italic' : 'roman'
}

/**
 * One character as mathematics sets it.
 *
 * A hyphen-minus is what a keyboard has and a MINUS SIGN is what an expression
 * means: `-\sin\theta` drawn with U+002D reads as a hyphen joining two words,
 * which at a diagram's font size is exactly what it looks like. U+2212 is the
 * same width as the plus it pairs with and sits on the same axis, which is the
 * whole reason the character exists.
 *
 * Only applied in MATH mode. `\text{well-known}` keeps its hyphen, because there
 * it is a hyphen — `atom()` checks the text depth before calling this.
 *
 * The superscript and subscript tables in `linear.ts` already map both spellings,
 * so `x^{-1}` still raises to `x⁻¹` rather than falling back to a spelled script.
 */
function mathematical(char: string): string {
  return char === '-' ? '−' : char
}

/** A node with a thin space after it, as one row. */
function followed(node: MathNode): MathNode {
  return { kind: 'row', items: [node, { kind: 'space' }] }
}

/** Whether a sub-tree draws nothing: `{}`, or a cell nobody filled in. */
function isEmpty(node: MathNode): boolean {
  return node.kind === 'row' && node.items.length === 0
}

/**
 * A cell without the whitespace that separated it from its `&`.
 *
 * `{pmatrix} a & b` gives cells of `" a "` and `" b "`, because this tokenizer
 * keeps spaces — which is right inside a `\text{}` and wrong at the edge of a
 * cell, where LaTeX itself ignores them. Left in, they push a matrix's columns off
 * centre and put double spaces through the selectable text. Trimming at the edges
 * only, so `\text{if } x` keeps the space the author put INSIDE the group.
 */
function trimCell(node: MathNode): MathNode {
  if (node.kind !== 'row' || !node.items.length) {
    return node
  }

  const items = [...node.items]
  const first = items[0] as MathNode
  const lastAt = items.length - 1

  if (first.kind === 'run') {
    items[0] = { kind: 'run', style: first.style, text: first.text.replace(/^\s+/u, '') }
  }

  // Read again rather than reusing `last`: in a one-item row the line above has
  // just replaced the same element, and the trailing trim has to see that copy.
  const trailing = items[lastAt] as MathNode

  if (trailing.kind === 'run') {
    items[lastAt] = { kind: 'run', style: trailing.style, text: trailing.text.replace(/\s+$/u, '') }
  }

  return { kind: 'row', items: items.filter(item => !(item.kind === 'run' && item.text === '')) }
}

/**
 * Glue adjacent runs of the same style into one.
 *
 * `12.5` is five atoms out of the tokenizer and one run out of here, which
 * matters for more than tidiness: the renderer emits a `Text` per run, and a
 * number split into five of them can have a line break inserted between any two
 * of its digits.
 */
function merged(items: MathNode[]): MathNode[] {
  const out: MathNode[] = []

  for (const item of items) {
    const last = out[out.length - 1]

    if (last && last.kind === 'run' && item.kind === 'run' && last.style === item.style) {
      out[out.length - 1] = { kind: 'run', style: last.style, text: last.text + item.text }

      continue
    }

    out.push(item)
  }

  return out
}

/** Set a whole sub-tree in one style, for `\mathrm` and its family. */
function restyle(node: MathNode, style: MathStyle): MathNode {
  switch (node.kind) {
    case 'run':
      return { kind: 'run', style, text: node.text }

    case 'row':
      return { kind: 'row', items: merged(node.items.map(item => restyle(item, style))) }

    default:
      // A fraction inside `\mathbf` is a fraction; the style applies to the
      // characters it reaches, and reaching further than that is not worth a
      // second traversal of every node kind.
      return node
  }
}

/**
 * Parse one expression, or answer `null` when it cannot be drawn.
 *
 * `null` means "show the source", never "show nothing". Every caller in this
 * folder treats it that way and the tests pin that they do.
 */
export function parseMath(source: string): MathNode | null {
  const trimmed = source.trim()

  if (!trimmed || trimmed.length > MAX_LENGTH) {
    return null
  }

  const atoms = tokenize(trimmed)

  if (!atoms || !atoms.length) {
    return null
  }

  const node = new Parser(atoms).parse()

  // An empty row is `{}` or whitespace: nothing to draw, so nothing to claim.
  return node && node.kind === 'row' && !node.items.length ? null : node
}

/**
 * Whether a character is a digit, for the renderer's spacing rule.
 *
 * Exported so the renderer does not keep a second copy of the same test.
 */
export function isDigit(char: string): boolean {
  return DIGIT_RE.test(char)
}
