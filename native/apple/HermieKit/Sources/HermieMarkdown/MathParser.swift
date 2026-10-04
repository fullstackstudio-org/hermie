import Foundation

// LaTeX mathematics, parsed into a tree the views can lay out, or not at all.
//
// A subset, as in the web and Expo clients (`packages/markdown/src/math/parse.ts`): symbols, scripts,
// fractions, roots, the big operators with their limits, fences, the common font and accent commands
// and the grid environments (`pmatrix`, `cases`, `aligned`, …). What is outside the subset answers
// `nil`, and the caller shows the LaTeX source, which is honest, copyable and what the model wrote:
// dropping a command we do not know would quietly change what the mathematics says.
//
// Pure and total: no SwiftUI, never traps, and a half-typed expression (a streaming reply is a prefix of
// an expression more often than an expression) is `nil`.

/// How a run of characters is set. A variable is italic, a number and an operator upright.
public enum MathStyle: Sendable, Hashable {
  case italic, roman, bold, mono
}

public enum MathGridStyle: Sendable, Hashable {
  case matrix, cases, aligned, gathered
}

public indirect enum MathNode: Sendable, Hashable {
  /// Characters already resolved from whatever wrote them.
  case run(String, MathStyle)
  case row([MathNode])
  /// A base with a superscript, a subscript, or both.
  case scripts(base: MathNode, sup: MathNode?, sub: MathNode?)
  /// A big operator (`∑`, `∫`, `lim`) with its limits.
  case op(symbol: String, upper: MathNode?, lower: MathNode?)
  case frac(numerator: MathNode, denominator: MathNode)
  case sqrt(radicand: MathNode, index: MathNode?)
  /// A group between delimiters that grow with what is inside.
  case fenced(open: String, close: String, body: MathNode)
  /// A character combined onto the base.
  case accent(base: MathNode, combining: String)
  case space
  /// Rows of cells: every environment, `\binom`, and a bare `\\`.
  case grid(rows: [[MathNode]], open: String, close: String, style: MathGridStyle)
}

public enum MathParser {
  /// The longest expression looked at: a guard against re-parsing a thousand lines of prose that a
  /// model wrote after an unclosed `$$`, on every flush.
  public static let maximumLength = 4000
  static let maximumDepth = 24
  static let maximumRows = 16
  static let maximumColumns = 8

  /// The expression as a tree, or `nil` when it is empty, outside the subset, or not (yet) well formed.
  public static func parse(_ source: String) -> MathNode? {
    let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= maximumLength else { return nil }
    guard let atoms = tokenize(trimmed) else { return nil }
    var parser = Parser(atoms: atoms)
    guard let node = parser.parseRow(end: .eof, depth: 0), parser.atEnd else { return nil }
    return node
  }

  // MARK: Tokens

  enum Atom: Equatable {
    case char(Character)
    case command(String)
    case open
    case close
    case sup
    case sub
    case ampersand
    case newline
    /// The braced argument of `\text` and its kin, as written: spaces count in text.
    case text(String)
  }

  static func tokenize(_ source: String) -> [Atom]? {
    var atoms: [Atom] = []
    let chars = Array(source)
    var index = 0
    while index < chars.count {
      let char = chars[index]
      switch char {
      case "\\":
        guard index + 1 < chars.count else { return nil }  // a half-typed command
        let next = chars[index + 1]
        if next == "\\" {
          atoms.append(.newline)
          index += 2
        } else if next.isASCII, next.isLetter {
          var end = index + 1
          while end < chars.count, chars[end].isASCII, chars[end].isLetter { end += 1 }
          let name = String(chars[(index + 1)..<end])
          atoms.append(.command(name))
          index = end
          if MathParser.textMode.contains(name) {
            // The group after a text command is read whole, spaces and all.
            var look = index
            while look < chars.count, chars[look] == " " { look += 1 }
            if look < chars.count, chars[look] == "{" {
              var level = 0
              var raw = ""
              var cursor = look
              var closed = false
              while cursor < chars.count {
                let c = chars[cursor]
                if c == "\\", cursor + 1 < chars.count {
                  let next = chars[cursor + 1]
                  raw.append(next.isLetter ? c : next)
                  if next.isLetter { raw.append(next) }
                  cursor += 2
                  continue
                }
                if c == "{" { level += 1; if level > 1 { raw.append(c) } } else if c == "}" {
                  level -= 1
                  if level == 0 { closed = true; cursor += 1; break }
                  raw.append(c)
                } else { raw.append(c) }
                cursor += 1
              }
              guard closed else { return nil }
              atoms.append(.text(raw))
              index = cursor
            }
          }
        } else {
          atoms.append(.command(String(next)))
          index += 2
        }
      case "{": atoms.append(.open); index += 1
      case "}": atoms.append(.close); index += 1
      case "^": atoms.append(.sup); index += 1
      case "_": atoms.append(.sub); index += 1
      case "&": atoms.append(.ampersand); index += 1
      case " ", "\t", "\n", "\r": index += 1
      case "%":
        // A comment runs to the end of the line.
        while index < chars.count, chars[index] != "\n" { index += 1 }
      default:
        atoms.append(.char(char))
        index += 1
      }
    }
    return atoms
  }

  // MARK: Parser

  enum End { case eof, close, right, cell }

  static let spacing: Set<String> = [",", ":", ";", "!", " ", "quad", "qquad", "thinspace", "enspace", "hspace"]
  static let functionNames: Set<String> = [
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg",
    "exp", "det", "dim", "ker", "deg", "gcd", "mod", "Pr", "arg", "min", "max", "sup", "inf", "lim"
  ]
  static let delimiters: [String: String] = [
    "{": "{", "}": "}", "lbrace": "{", "rbrace": "}", "langle": "⟨", "rangle": "⟩", "lceil": "⌈", "rceil": "⌉",
    "lfloor": "⌊", "rfloor": "⌋", "vert": "|", "Vert": "‖", "|": "‖", ".": ""
  ]
  static let fonts: [String: MathStyle] = [
    "text": .roman, "textrm": .roman, "mathrm": .roman, "operatorname": .roman, "textbf": .bold, "mathbf": .bold,
    "boldsymbol": .bold, "bm": .bold, "textit": .italic, "mathit": .italic, "texttt": .mono, "mathtt": .mono,
    "mathsf": .roman, "mathbb": .roman, "mathcal": .roman, "mathfrak": .roman, "mathscr": .roman
  ]
  static let textMode: Set<String> = ["text", "textrm", "textbf", "textit", "texttt", "operatorname"]
  /// Blackboard bold, where Unicode has the letter.
  static let blackboard: [Character: String] = [
    "R": "ℝ", "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "C": "ℂ", "P": "ℙ", "H": "ℍ", "E": "𝔼", "1": "𝟙"
  ]
  static let environments: [String: (open: String, close: String, style: MathGridStyle)] = [
    "matrix": ("", "", .matrix), "smallmatrix": ("", "", .matrix), "pmatrix": ("(", ")", .matrix),
    "bmatrix": ("[", "]", .matrix), "Bmatrix": ("{", "}", .matrix), "vmatrix": ("|", "|", .matrix),
    "Vmatrix": ("‖", "‖", .matrix), "cases": ("{", "", .cases), "dcases": ("{", "", .cases),
    "aligned": ("", "", .aligned), "align": ("", "", .aligned), "align*": ("", "", .aligned),
    "split": ("", "", .aligned), "gathered": ("", "", .gathered), "gather": ("", "", .gathered),
    "gather*": ("", "", .gathered), "equation": ("", "", .gathered), "equation*": ("", "", .gathered)
  ]

  struct Parser {
    let atoms: [Atom]
    var position = 0
    var atEnd: Bool { position >= atoms.count }

    init(atoms: [Atom]) {
      self.atoms = atoms
    }

    func peek() -> Atom? { position < atoms.count ? atoms[position] : nil }

    /// Items up to `end`, as a row (or the single item). `nil` when something in it is not parsable.
    mutating func parseRow(end: End, depth: Int, textMode: Bool = false) -> MathNode? {
      guard depth <= MathParser.maximumDepth else { return nil }
      var items: [MathNode] = []
      loop: while let atom = peek() {
        switch (atom, end) {
        case (.close, .close): break loop
        case (.command("right"), .right): break loop
        case (.command("end"), .cell), (.ampersand, .cell), (.newline, .cell): break loop
        default: break
        }
        guard let item = parseItem(depth: depth, textMode: textMode) else { return nil }
        items.append(item)
      }
      switch end {
      case .eof: break
      case .close: guard peek() == .close else { return nil }
      case .right: guard peek() == .command("right") else { return nil }
      case .cell: break
      }
      return items.count == 1 ? items[0] : .row(items)
    }

    /// One atom with the scripts that follow it.
    mutating func parseItem(depth: Int, textMode: Bool) -> MathNode? {
      guard let base = parseAtom(depth: depth, textMode: textMode) else { return nil }
      var sup: MathNode?
      var sub: MathNode?
      while let next = peek(), next == .sup || next == .sub {
        position += 1
        guard let script = parseArgument(depth: depth + 1) else { return nil }
        if next == .sup {
          guard sup == nil else { return nil }
          sup = script
        } else {
          guard sub == nil else { return nil }
          sub = script
        }
      }
      guard sup != nil || sub != nil else { return base }
      if case .op(let symbol, nil, nil) = base {
        return .op(symbol: symbol, upper: sup, lower: sub)
      }
      return .scripts(base: base, sup: sup, sub: sub)
    }

    /// The argument of a command or a script: a braced group or a single token.
    mutating func parseArgument(depth: Int) -> MathNode? {
      guard depth <= MathParser.maximumDepth, let atom = peek() else { return nil }
      if atom == .open {
        position += 1
        guard let body = parseRow(end: .close, depth: depth + 1) else { return nil }
        position += 1
        return body
      }
      if case .command(let name) = atom, name == "right" || name == "end" { return nil }
      if atom == .close || atom == .sup || atom == .sub || atom == .ampersand || atom == .newline { return nil }
      if case .text = atom { return nil }
      return parseAtom(depth: depth + 1, textMode: false)
    }

    /// A braced group read as text: spaces kept, nothing resolved.
    mutating func parseText(style: MathStyle) -> MathNode? {
      if case .text(let raw)? = peek() {
        position += 1
        return .run(raw, style)
      }
      guard peek() == .open else { return nil }
      position += 1
      var text = ""
      var level = 1
      while let atom = peek() {
        position += 1
        switch atom {
        case .open: level += 1
        case .close:
          level -= 1
          if level == 0 { return .run(text, style) }
        case .char(let c): text.append(c)
        case .command(let name):
          // Inside text a space command is a space; a symbol command is its character.
          if MathParser.spacing.contains(name) { text.append(" ") } else if let symbol = MathSymbols.symbols[name] { text += symbol } else if name.count == 1, "{}%$&#_".contains(name) { text += name } else { return nil }
        case .sup: text.append("^")
        case .sub: text.append("_")
        case .ampersand: text.append("&")
        case .newline: text.append(" ")
        case .text(let raw): text += raw
        }
      }
      return nil
    }

    mutating func parseAtom(depth: Int, textMode: Bool) -> MathNode? {
      guard depth <= MathParser.maximumDepth, let atom = peek() else { return nil }
      position += 1
      switch atom {
      case .open:
        guard let body = parseRow(end: .close, depth: depth + 1) else { return nil }
        position += 1
        return body
      case .close, .sup, .sub, .ampersand, .newline, .text:
        return nil
      case .char(let c):
        return MathParser.character(c)
      case .command(let name):
        return parseCommand(name, depth: depth)
      }
    }

    mutating func parseCommand(_ name: String, depth: Int) -> MathNode? {
      if let symbol = MathSymbols.symbols[name] { return .run(symbol, .roman) }
      if MathParser.spacing.contains(name) {
        // `\hspace{1em}` takes a group that is dropped.
        if name == "hspace", peek() == .open { _ = parseArgument(depth: depth + 1) }
        return .space
      }
      if let symbol = MathSymbols.bigOperators[name] { return .op(symbol: symbol, upper: nil, lower: nil) }
      if MathParser.functionNames.contains(name) { return .run(name, .roman) }
      if let combining = MathSymbols.accents[name] {
        guard let base = parseArgument(depth: depth + 1) else { return nil }
        return .accent(base: base, combining: combining)
      }
      if let style = MathParser.fonts[name] {
        if MathParser.textMode.contains(name) { return parseText(style: style) }
        guard let body = parseArgument(depth: depth + 1) else { return nil }
        if name == "mathbb", case .run(let text, _) = body, text.count == 1, let mapped = MathParser.blackboard[text.first!] {
          return .run(mapped, .roman)
        }
        return restyled(body, style)
      }
      switch name {
      case "frac", "dfrac", "tfrac", "cfrac":
        guard let numerator = parseArgument(depth: depth + 1), let denominator = parseArgument(depth: depth + 1) else { return nil }
        return .frac(numerator: numerator, denominator: denominator)
      case "binom", "dbinom", "tbinom":
        guard let top = parseArgument(depth: depth + 1), let bottom = parseArgument(depth: depth + 1) else { return nil }
        return .grid(rows: [[top], [bottom]], open: "(", close: ")", style: .matrix)
      case "sqrt":
        var index: MathNode?
        // An optional `[n]`.
        if peek() == .char("[") {
          position += 1
          var items: [MathNode] = []
          while let atom = peek(), atom != .char("]") {
            guard let item = parseItem(depth: depth + 1, textMode: false) else { return nil }
            items.append(item)
          }
          guard peek() == .char("]") else { return nil }
          position += 1
          index = items.count == 1 ? items[0] : .row(items)
        }
        guard let radicand = parseArgument(depth: depth + 1) else { return nil }
        return .sqrt(radicand: radicand, index: index)
      case "left":
        guard let open = parseDelimiter(), let body = parseRow(end: .right, depth: depth + 1) else { return nil }
        position += 1  // `\right`
        guard let close = parseDelimiter() else { return nil }
        return .fenced(open: open, close: close, body: body)
      case "begin":
        return parseEnvironment(depth: depth)
      case "end", "right":
        return nil
      case "{", "}", "%", "$", "&", "#", "_":
        return .run(name, .roman)
      case "|":
        return .run("‖", .roman)
      case "lbrace", "rbrace", "langle", "rangle", "lceil", "rceil", "lfloor", "rfloor", "vert", "Vert":
        return .run(MathParser.delimiters[name] ?? "", .roman)
      case "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "big", "Big", "bigg", "Bigg":
        return .row([])
      case "not":
        // `\not=` and the like: a slash over the next symbol.
        guard let next = parseAtom(depth: depth + 1, textMode: false) else { return nil }
        return .accent(base: next, combining: "\u{0338}")
      case "overset", "underset", "stackrel":
        guard let top = parseArgument(depth: depth + 1), let base = parseArgument(depth: depth + 1) else { return nil }
        return name == "underset" ? .scripts(base: base, sup: nil, sub: top) : .scripts(base: base, sup: top, sub: nil)
      default:
        return nil
      }
    }

    /// A delimiter after `\left` or `\right`: a character or a command that names one.
    mutating func parseDelimiter() -> String? {
      guard let atom = peek() else { return nil }
      position += 1
      switch atom {
      case .char(let c):
        guard "()[]|<>/.".contains(c) else { return nil }
        if c == "." { return "" }
        if c == "<" { return "⟨" }
        if c == ">" { return "⟩" }
        return String(c)
      case .command(let name): return MathParser.delimiters[name]
      default: return nil
      }
    }

    mutating func parseEnvironment(depth: Int) -> MathNode? {
      guard let name = parseText(style: .roman), case .run(let environment, _) = name,
        let spec = MathParser.environments[environment]
      else { return nil }
      var rows: [[MathNode]] = [[]]
      while true {
        guard let cell = parseRow(end: .cell, depth: depth + 1) else { return nil }
        rows[rows.count - 1].append(cell)
        guard let atom = peek() else { return nil }
        position += 1
        switch atom {
        case .ampersand:
          guard rows[rows.count - 1].count < MathParser.maximumColumns else { return nil }
        case .newline:
          guard rows.count < MathParser.maximumRows else { return nil }
          rows.append([])
        case .command("end"):
          guard let closing = parseText(style: .roman), case .run(let closed, _) = closing, closed == environment else { return nil }
          // A trailing `\\` leaves an empty last row.
          if rows.last?.count == 1, case .row(let items) = rows.last![0], items.isEmpty { rows.removeLast() }
          return .grid(rows: rows, open: spec.open, close: spec.close, style: spec.style)
        default:
          return nil
        }
      }
    }

    /// `node` with its runs set in `style`.
    func restyled(_ node: MathNode, _ style: MathStyle) -> MathNode {
      switch node {
      case .run(let text, let old): return .run(text, old == .italic || old == .roman ? style : old)
      case .row(let items): return .row(items.map { restyled($0, style) })
      case .scripts(let base, let sup, let sub):
        return .scripts(base: restyled(base, style), sup: sup.map { restyled($0, style) }, sub: sub.map { restyled($0, style) })
      default: return node
      }
    }
  }

  /// One typed character as a run: a letter is a variable (italic), the rest upright, `-` a minus.
  static func character(_ c: Character) -> MathNode {
    switch c {
    case "-": return .run("−", .roman)
    case "*": return .run("∗", .roman)
    case "'": return .run("′", .roman)
    case "<": return .run("<", .roman)
    default:
      if c.isLetter { return .run(String(c), .italic) }
      return .run(String(c), .roman)
    }
  }
}
