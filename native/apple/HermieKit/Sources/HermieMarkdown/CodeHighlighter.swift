import Foundation

// A small syntax highlighter for fenced code, written for this app: no grammar
// library, no regular expression engine. A listing goes in, a list of tokens
// comes out, and the tokens' texts concatenate back to the listing exactly, so
// colouring can never lose or reorder a character.
//
// It is a lexer, not a parser: it knows comments, strings, numbers, a
// language's keywords, literals and (by capitalisation) types, and for the few
// languages where it matters the shape of a key (JSON, YAML, CSS) or a tag
// (HTML). That is what makes a listing readable at a glance, and it never
// fails: a listing in a language it does not know, or one that is half
// streamed, is simply plain text or a token that runs to the end.

/// What a stretch of a listing is, for colouring. The names follow the scopes
/// of the web client's highlighter (`packages/markdown/src/code-theme.ts`) so
/// the two clients draw the same listing in the same colours.
public enum CodeTokenKind: UInt8, Sendable, Hashable, CaseIterable {
  case plain
  case keyword
  case string
  case comment
  case number
  /// `true`, `false`, `nil`, `null`, `None` and the like.
  case literal
  case type
  case function
  /// A key (JSON, YAML, CSS property, HTML attribute).
  case property
  /// A decorator, an annotation, a preprocessor line.
  case attribute
  /// An HTML tag name or a CSS selector.
  case tag
  /// `$NAME` in a shell script.
  case variable
  /// A line a diff added, deleted, or a hunk header.
  case addition
  case deletion
  case meta
}

/// One run of a listing: all of its characters are of one kind.
public struct CodeToken: Sendable, Hashable {
  public var kind: CodeTokenKind
  public var text: String

  public init(_ kind: CodeTokenKind, _ text: String) {
    self.kind = kind
    self.text = text
  }
}

/// The languages the highlighter knows, by every name a fence is given them.
public enum CodeLanguage: String, Sendable, CaseIterable {
  case swift, python, javascript, typescript, json, bash, go, rust, html, css, yaml, sql, diff
  case clike

  /// The language a fence's info string names, or `nil` for one the highlighter
  /// does not know (the listing is then drawn in the text colour).
  public static func named(_ info: String?) -> CodeLanguage? {
    guard let info else { return nil }
    let name = info.trimmingCharacters(in: .whitespaces).lowercased()
    switch name {
    case "swift": return .swift
    case "python", "py", "python3", "py3": return .python
    case "javascript", "js", "jsx", "mjs", "cjs", "node": return .javascript
    case "typescript", "ts", "tsx", "mts", "cts": return .typescript
    case "json", "jsonc", "json5", "jsonl", "ndjson": return .json
    case "bash", "sh", "shell", "zsh", "console", "shell-session", "terminal": return .bash
    case "go", "golang": return .go
    case "rust", "rs": return .rust
    case "html", "xml", "svg", "xhtml", "htm", "vue", "plist": return .html
    case "css", "scss", "less": return .css
    case "yaml", "yml", "toml", "ini": return .yaml
    case "sql", "mysql", "postgres", "postgresql", "sqlite", "psql", "plpgsql": return .sql
    case "diff", "patch": return .diff
    case "c", "cpp", "c++", "cc", "h", "hpp", "java", "kotlin", "kt", "csharp", "cs", "dart", "scala", "php":
      return .clike
    default: return nil
    }
  }

  /// Whether `info` is a name this highlighter draws.
  public static func isKnown(_ info: String?) -> Bool {
    named(info) != nil
  }
}

public enum CodeHighlighter {
  /// A listing longer than this is not highlighted (it is drawn plain), so a pasted log cannot
  /// stall a row.
  public static let maximumLength = 30_000

  /// The tokens of `source` as `language`. The texts of the tokens joined are `source`.
  public static func tokens(_ source: String, language: String?) -> [CodeToken] {
    guard !source.isEmpty else { return [] }
    guard let resolved = CodeLanguage.named(language), source.utf8.count <= maximumLength else {
      return [CodeToken(.plain, source)]
    }
    return tokens(source, language: resolved)
  }

  public static func tokens(_ source: String, language: CodeLanguage) -> [CodeToken] {
    guard !source.isEmpty else { return [] }
    var lexer = Lexer(Array(source.utf8))
    switch language {
    case .json: lexer.json()
    case .html: lexer.html()
    case .css: lexer.css()
    case .yaml: lexer.yaml()
    case .diff: lexer.diff()
    case .bash: lexer.generic(Specs.bash)
    case .swift: lexer.generic(Specs.swift)
    case .python: lexer.generic(Specs.python)
    case .javascript: lexer.generic(Specs.javascript)
    case .typescript: lexer.generic(Specs.typescript)
    case .go: lexer.generic(Specs.go)
    case .rust: lexer.generic(Specs.rust)
    case .sql: lexer.generic(Specs.sql)
    case .clike: lexer.generic(Specs.clike)
    }
    return lexer.finish()
  }

  /// `tokens`, remembered: a block that is drawn again (the row came back into view, the colour
  /// scheme changed) gets its tokens without the lexer running again.
  public static func cachedTokens(_ source: String, language: String?) -> [CodeToken] {
    guard source.utf8.count <= maximumLength else { return tokens(source, language: language) }
    let key = "\(CodeLanguage.named(language)?.rawValue ?? "")\n\(source)" as NSString
    if let hit = TokenCache.shared.object(forKey: key) {
      return hit.tokens
    }
    let made = tokens(source, language: language)
    TokenCache.shared.setObject(TokenBox(made), forKey: key, cost: source.utf8.count)
    return made
  }
}

private final class TokenBox: NSObject {
  let tokens: [CodeToken]
  init(_ tokens: [CodeToken]) { self.tokens = tokens }
}

private enum TokenCache {
  nonisolated(unsafe) static let shared: NSCache<NSString, TokenBox> = {
    let cache = NSCache<NSString, TokenBox>()
    cache.totalCostLimit = 2_000_000
    cache.countLimit = 400
    return cache
  }()
}

// MARK: - Language descriptions

struct LanguageSpec: Sendable {
  var lineComments: [[UInt8]] = []
  var blockComment: (open: [UInt8], close: [UInt8])?
  var nestedBlockComments = false
  var quotes: Set<UInt8> = [0x22, 0x27]
  /// `"""` and `'''` open a string that runs across lines.
  var tripleQuotes = false
  /// A backtick string may run across lines (JavaScript templates, Go raw strings).
  var multilineBackticks = false
  /// A `\` in a string escapes the next byte. Shell single quotes and Go raw strings do not.
  var noEscapeQuotes: Set<UInt8> = []
  var keywords: Set<String> = []
  var literals: Set<String> = []
  /// Built-in type names that are not capitalised (`int`, `str`, `String` is by capital).
  var types: Set<String> = []
  var caseInsensitive = false
  /// A capitalised word with a lower-case letter in it is a type.
  var capitalisedTypes = true
  /// A word directly before `(` is a function.
  var calls = true
  /// `@name` is an attribute.
  var atAttributes = false
  /// `#name` (Swift's `#if`, `#available`) is an attribute.
  var hashDirectives = false
  /// `$NAME`, `${…}` and `$(` are variables.
  var dollarVariables = false
  /// A `#` starts a comment only at the start of a word (a shell's `$#` and `a#b` are not one).
  var commentNeedsBoundary = false
  /// Rust's `'a` lifetimes.
  var lifetimes = false
  /// Python's `r"…"`, `f"…"` prefixes.
  var stringPrefixes = false
  /// Rust's `name!(`.
  var macros = false
  /// A `$` is a letter in a name (JavaScript).
  var dollarInNames = false
}

private enum Specs {
  static func words(_ text: String) -> Set<String> {
    Set(text.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))
  }

  static let swift: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x2F, 0x2F]]
    spec.blockComment = (Array("/*".utf8), Array("*/".utf8))
    spec.nestedBlockComments = true
    spec.quotes = [0x22]
    spec.tripleQuotes = true
    spec.atAttributes = true
    spec.hashDirectives = true
    spec.keywords = words(
      """
      actor any as associatedtype async await break case catch class consume continue convenience default defer
      deinit didSet do dynamic else enum extension fallthrough fileprivate final for func get guard if import in
      indirect infix init inout internal is isolated lazy let mutating nonisolated nonmutating open operator
      optional override package postfix precedencegroup prefix private protocol public repeat required rethrows
      return set some static struct subscript super switch throw throws try typealias unowned var weak where
      while willSet borrowing consuming copy each macro
      """)
    spec.literals = words("true false nil self Self")
    spec.types = words("Int Int8 Int16 Int32 Int64 UInt UInt8 UInt16 UInt32 UInt64 Double Float Bool String Character Void Any AnyObject")
    return spec
  }()

  static let python: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x23]]
    spec.tripleQuotes = true
    spec.stringPrefixes = true
    spec.atAttributes = true
    spec.keywords = words(
      """
      and as assert async await break case class continue def del elif else except finally for from global if
      import in is lambda match nonlocal not or pass raise return try while with yield
      """)
    spec.literals = words("True False None self cls")
    spec.types = words("int float str bool list dict set tuple bytes object type")
    return spec
  }()

  static let javascript: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x2F, 0x2F]]
    spec.blockComment = (Array("/*".utf8), Array("*/".utf8))
    spec.quotes = [0x22, 0x27, 0x60]
    spec.multilineBackticks = true
    spec.dollarInNames = true
    spec.keywords = words(
      """
      async await break case catch class const continue debugger default delete do else export extends finally
      for from function get if import in instanceof let new of return set static super switch throw try typeof
      var void while with yield
      """)
    spec.literals = words("true false null undefined this NaN Infinity")
    return spec
  }()

  static let typescript: LanguageSpec = {
    var spec = javascript
    spec.keywords.formUnion(
      words(
        """
        abstract as declare enum implements interface keyof namespace private protected public readonly satisfies
        type infer is asserts override module unique
        """))
    spec.types = words("string number boolean any unknown never void object symbol bigint")
    return spec
  }()

  static let go: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x2F, 0x2F]]
    spec.blockComment = (Array("/*".utf8), Array("*/".utf8))
    spec.quotes = [0x22, 0x27, 0x60]
    spec.multilineBackticks = true
    spec.noEscapeQuotes = [0x60]
    spec.keywords = words(
      """
      break case chan const continue default defer else fallthrough for func go goto if import interface map
      package range return select struct switch type var
      """)
    spec.literals = words("true false nil iota")
    spec.types = words(
      "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any")
    return spec
  }()

  static let rust: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x2F, 0x2F]]
    spec.blockComment = (Array("/*".utf8), Array("*/".utf8))
    spec.nestedBlockComments = true
    spec.quotes = [0x22, 0x27]
    spec.lifetimes = true
    spec.macros = true
    spec.keywords = words(
      """
      as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut
      pub ref return static struct super trait type unsafe use where while union
      """)
    spec.literals = words("true false self Self None Some Ok Err")
    spec.types = words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box")
    spec.atAttributes = false
    return spec
  }()

  static let bash: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x23]]
    spec.commentNeedsBoundary = true
    spec.quotes = [0x22, 0x27]
    spec.noEscapeQuotes = [0x27]
    spec.dollarVariables = true
    spec.capitalisedTypes = false
    spec.calls = false
    spec.keywords = words(
      """
      if then else elif fi for while until do done case esac in function select time return exit break continue
      export local readonly declare unset source alias set shift trap eval exec cd echo printf read test sudo
      """)
    spec.literals = words("true false")
    return spec
  }()

  static let sql: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x2D, 0x2D]]
    spec.blockComment = (Array("/*".utf8), Array("*/".utf8))
    spec.quotes = [0x27, 0x22, 0x60]
    spec.caseInsensitive = true
    spec.capitalisedTypes = false
    spec.calls = false
    spec.keywords = words(
      """
      select from where and or not in is as on join inner outer left right full cross natural using group by
      order having limit offset union all distinct insert into values update set delete create table alter drop
      index view primary key foreign references unique default check constraint add column begin commit rollback
      transaction exists between like ilike case when then else end with returning explain analyze asc desc
      cascade truncate grant revoke replace if temporary temp trigger function procedure schema database over
      partition window fetch next rows only
      """)
    spec.literals = words("true false null")
    spec.types = words(
      """
      int integer bigint smallint serial bigserial text varchar char boolean bool date time timestamp timestamptz
      numeric decimal real float double json jsonb uuid bytea
      """)
    return spec
  }()

  static let clike: LanguageSpec = {
    var spec = LanguageSpec()
    spec.lineComments = [[0x2F, 0x2F]]
    spec.blockComment = (Array("/*".utf8), Array("*/".utf8))
    spec.atAttributes = true
    spec.hashDirectives = true
    spec.keywords = words(
      """
      abstract auto break case catch class const constexpr continue default delete do else enum explicit export
      extends extern final finally for friend fun goto if implements import include inline interface internal
      is namespace new operator override package private protected public register return sealed sizeof static
      struct super switch synchronized template this throw throws try typedef typename union using val var
      virtual volatile when while
      """)
    spec.literals = words("true false null nullptr NULL this")
    spec.types = words("int long short char float double bool boolean void unsigned signed byte string size_t")
    return spec
  }()
}

// MARK: - The lexer

private struct Lexer {
  let b: [UInt8]
  var i = 0
  private var spans: [(kind: CodeTokenKind, start: Int, end: Int)] = []

  init(_ bytes: [UInt8]) {
    self.b = bytes
  }

  // MARK: Output

  mutating func emit(_ kind: CodeTokenKind, _ start: Int, _ end: Int) {
    guard end > start else { return }
    if let last = spans.last, last.kind == kind, last.end == start {
      spans[spans.count - 1].end = end
    } else {
      spans.append((kind, start, end))
    }
  }

  func finish() -> [CodeToken] {
    spans.map { CodeToken($0.kind, String(decoding: b[$0.start..<$0.end], as: UTF8.self)) }
  }

  // MARK: Byte classes

  static func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }
  static func isLetter(_ c: UInt8) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
  static func isWordStart(_ c: UInt8, dollar: Bool = false) -> Bool {
    isLetter(c) || c == 0x5F || c >= 0x80 || (dollar && c == 0x24)
  }
  static func isWord(_ c: UInt8, dollar: Bool = false) -> Bool { isWordStart(c, dollar: dollar) || isDigit(c) }
  static func isSpace(_ c: UInt8) -> Bool { c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D }

  func at(_ index: Int) -> UInt8? { index < b.count ? b[index] : nil }

  func starts(with pattern: [UInt8], at index: Int) -> Bool {
    guard !pattern.isEmpty, index + pattern.count <= b.count else { return false }
    for offset in 0..<pattern.count where b[index + offset] != pattern[offset] {
      return false
    }
    return true
  }

  func lineEnd(from index: Int) -> Int {
    var j = index
    while j < b.count, b[j] != 0x0A { j += 1 }
    return j
  }

  // MARK: Pieces every language shares

  /// A number starting at `i`; returns where it ends.
  func numberEnd(from start: Int) -> Int {
    var j = start
    if b[j] == 0x30, let next = at(j + 1), next == 0x78 || next == 0x58 || next == 0x62 || next == 0x42 || next == 0x6F || next == 0x4F {
      j += 2
      while j < b.count, Self.isWord(b[j]) { j += 1 }
      return j
    }
    while j < b.count, Self.isDigit(b[j]) || b[j] == 0x5F { j += 1 }
    if at(j) == 0x2E, let next = at(j + 1), Self.isDigit(next) {
      j += 1
      while j < b.count, Self.isDigit(b[j]) || b[j] == 0x5F { j += 1 }
    }
    if let e = at(j), e == 0x65 || e == 0x45 {
      var k = j + 1
      if let sign = at(k), sign == 0x2B || sign == 0x2D { k += 1 }
      if let digit = at(k), Self.isDigit(digit) {
        j = k
        while j < b.count, Self.isDigit(b[j]) { j += 1 }
      }
    }
    // A suffix: `10u8`, `1.5f`, `3L`.
    while j < b.count, Self.isLetter(b[j]) || Self.isDigit(b[j]) || b[j] == 0x5F { j += 1 }
    return j
  }

  /// A string whose opening quote is at `start` (after any prefix). Returns where it ends; a
  /// string with no closing quote runs to the end of the line, or of the listing if it may span
  /// lines.
  func stringEnd(from start: Int, spec: LanguageSpec) -> Int {
    let quote = b[start]
    if spec.tripleQuotes, quote != 0x60, at(start + 1) == quote, at(start + 2) == quote {
      var j = start + 3
      while j < b.count {
        if b[j] == 0x5C { j += 2; continue }
        if b[j] == quote, at(j + 1) == quote, at(j + 2) == quote { return j + 3 }
        j += 1
      }
      return b.count
    }
    let multiline = quote == 0x60 && spec.multilineBackticks
    let escapes = !spec.noEscapeQuotes.contains(quote)
    var j = start + 1
    while j < b.count {
      let c = b[j]
      if escapes, c == 0x5C { j += 2; continue }
      if c == quote { return j + 1 }
      if c == 0x0A, !multiline { return j }
      j += 1
    }
    return min(j, b.count)
  }

  // MARK: The generic scanner

  mutating func generic(_ spec: LanguageSpec) {
    var plainStart = 0

    func flush(_ lexer: inout Lexer, _ upTo: Int) {
      lexer.emit(.plain, plainStart, upTo)
    }

    while i < b.count {
      let c = b[i]
      let start = i

      // Comments.
      if let block = spec.blockComment, starts(with: block.open, at: i) {
        flush(&self, start)
        i = blockCommentEnd(from: i, block: block, nested: spec.nestedBlockComments)
        emit(.comment, start, i)
        plainStart = i
        continue
      }
      if spec.lineComments.contains(where: { starts(with: $0, at: i) }),
        !spec.commentNeedsBoundary || i == 0 || Self.isSpace(b[i - 1]) || b[i - 1] == 0x3B || b[i - 1] == 0x28
      {
        flush(&self, start)
        i = lineEnd(from: i)
        emit(.comment, start, i)
        plainStart = i
        continue
      }

      // Strings.
      if spec.quotes.contains(c) {
        if spec.lifetimes, c == 0x27, let end = lifetimeOrCharEnd(from: i) {
          flush(&self, start)
          emit(end.isChar ? .string : .type, start, end.index)
          i = end.index
          plainStart = i
          continue
        }
        flush(&self, start)
        i = stringEnd(from: i, spec: spec)
        emit(.string, start, i)
        plainStart = i
        continue
      }

      // Numbers.
      if Self.isDigit(c), start == 0 || !Self.isWord(b[start - 1], dollar: spec.dollarInNames) {
        flush(&self, start)
        i = numberEnd(from: i)
        emit(.number, start, i)
        plainStart = i
        continue
      }

      // Variables of a shell.
      if spec.dollarVariables, c == 0x24 {
        let end = shellVariableEnd(from: i)
        if end > i + 1 {
          flush(&self, start)
          i = end
          emit(.variable, start, i)
          plainStart = i
          continue
        }
      }

      // Attributes.
      if (spec.atAttributes && c == 0x40) || (spec.hashDirectives && c == 0x23),
        let next = at(i + 1), Self.isWordStart(next)
      {
        // `#` of a C preprocessor line starts the line only.
        var j = i + 1
        while j < b.count, Self.isWord(b[j]) || b[j] == 0x2E { j += 1 }
        flush(&self, start)
        i = j
        emit(.attribute, start, i)
        plainStart = i
        continue
      }

      // Words.
      if Self.isWordStart(c, dollar: spec.dollarInNames) {
        var j = i + 1
        while j < b.count, Self.isWord(b[j], dollar: spec.dollarInNames) { j += 1 }
        let word = String(decoding: b[i..<j], as: UTF8.self)

        // Python-style string prefixes: r"…", f"""…""".
        if spec.stringPrefixes, j - i <= 2, let quote = at(j), quote == 0x22 || quote == 0x27,
          "rbfu".contains(word.lowercased().first!), word.lowercased().allSatisfy({ "rbfu".contains($0) })
        {
          flush(&self, start)
          i = stringEnd(from: j, spec: spec)
          emit(.string, start, i)
          plainStart = i
          continue
        }

        let key = spec.caseInsensitive ? word.lowercased() : word
        var kind: CodeTokenKind = .plain
        let introducer = spec.keywords.isEmpty ? nil : previousWord(before: start)
        if spec.keywords.contains(key) {
          kind = .keyword
        } else if let introducer, Self.functionIntroducers.contains(introducer) {
          kind = .function
        } else if let introducer, Self.typeIntroducers.contains(introducer) {
          kind = .type
        } else if spec.literals.contains(key) {
          kind = .literal
        } else if spec.types.contains(key) {
          kind = .type
        } else if spec.macros, at(j) == 0x21, at(j + 1) == 0x28 || at(j + 1) == 0x5B || at(j + 1) == 0x7B {
          kind = .function
        } else if spec.calls, at(j) == 0x28 {
          kind = .function
        } else if spec.capitalisedTypes, let first = word.utf8.first, first >= 0x41, first <= 0x5A,
          word.utf8.contains(where: { $0 >= 0x61 && $0 <= 0x7A })
        {
          kind = .type
        }
        if kind != .plain {
          flush(&self, start)
          emit(kind, start, j)
          plainStart = j
        }
        i = j
        continue
      }

      i += 1
    }
    flush(&self, b.count)
  }

  static let functionIntroducers: Set<String> = ["fn", "func", "def", "function", "fun"]
  static let typeIntroducers: Set<String> = [
    "class", "struct", "enum", "trait", "interface", "impl", "protocol", "extension", "actor", "typealias", "union"
  ]

  /// The word that ends right before `index`, with only spaces between: `fn` in `fn name`.
  func previousWord(before index: Int) -> String? {
    var j = index
    while j > 0, b[j - 1] == 0x20 || b[j - 1] == 0x09 { j -= 1 }
    guard j < index, j > 0, Self.isWord(b[j - 1]) else { return nil }
    var k = j
    while k > 0, Self.isWord(b[k - 1]) { k -= 1 }
    return String(decoding: b[k..<j], as: UTF8.self)
  }

  func blockCommentEnd(from start: Int, block: (open: [UInt8], close: [UInt8]), nested: Bool) -> Int {
    var j = start + block.open.count
    var depth = 1
    while j < b.count {
      if nested, starts(with: block.open, at: j) {
        depth += 1
        j += block.open.count
      } else if starts(with: block.close, at: j) {
        depth -= 1
        j += block.close.count
        if depth == 0 { return j }
      } else {
        j += 1
      }
    }
    return b.count
  }

  /// `$name`, `${…}`, `$(`, `$1`, `$?`, `$#`, `$@`: where the variable ends, or `from + 1` when it
  /// is not one.
  func shellVariableEnd(from start: Int) -> Int {
    guard let next = at(start + 1) else { return start + 1 }
    if next == 0x7B {
      var j = start + 2
      while j < b.count, b[j] != 0x7D, b[j] != 0x0A { j += 1 }
      return at(j) == 0x7D ? j + 1 : j
    }
    if next == 0x28 { return start + 2 }
    if Self.isWordStart(next) {
      var j = start + 1
      while j < b.count, Self.isWord(b[j]) { j += 1 }
      return j
    }
    if Self.isDigit(next) || next == 0x3F || next == 0x23 || next == 0x40 || next == 0x2A || next == 0x24 || next == 0x21 {
      return start + 2
    }
    return start + 1
  }

  /// At a `'` in Rust: `'a'` and `'\n'` are characters, `'a` and `'static` are lifetimes, a lone
  /// `'` is neither.
  func lifetimeOrCharEnd(from start: Int) -> (index: Int, isChar: Bool)? {
    guard let first = at(start + 1) else { return nil }
    if first == 0x5C {
      var j = start + 2
      while j < b.count, b[j] != 0x27, b[j] != 0x0A { j += 1 }
      return (at(j) == 0x27 ? j + 1 : j, true)
    }
    if Self.isWordStart(first) {
      // 'x' (one scalar, then a quote) is a character; otherwise a lifetime.
      var length = 1
      if first >= 0x80 {
        while let c = at(start + 1 + length), c >= 0x80, c < 0xC0 { length += 1 }
      }
      if at(start + 1 + length) == 0x27 { return (start + 2 + length, true) }
      var j = start + 1
      while j < b.count, Self.isWord(b[j]) { j += 1 }
      return (j, false)
    }
    if at(start + 2) == 0x27 { return (start + 3, true) }
    return nil
  }

  // MARK: JSON

  mutating func json() {
    var plainStart = 0
    while i < b.count {
      let c = b[i]
      let start = i
      if c == 0x22 {
        emit(.plain, plainStart, start)
        let end = stringEnd(from: i, spec: LanguageSpec())
        // A string followed by a colon is a key.
        var j = end
        while j < b.count, b[j] == 0x20 || b[j] == 0x09 { j += 1 }
        emit(at(j) == 0x3A ? .property : .string, start, end)
        i = end
        plainStart = i
      } else if c == 0x2F, at(i + 1) == 0x2F {
        emit(.plain, plainStart, start)
        i = lineEnd(from: i)
        emit(.comment, start, i)
        plainStart = i
      } else if c == 0x2F, at(i + 1) == 0x2A {
        emit(.plain, plainStart, start)
        i = blockCommentEnd(from: i, block: (Array("/*".utf8), Array("*/".utf8)), nested: false)
        emit(.comment, start, i)
        plainStart = i
      } else if Self.isDigit(c) || (c == 0x2D && at(i + 1).map(Self.isDigit) == true) {
        emit(.plain, plainStart, start)
        i = numberEnd(from: c == 0x2D ? i + 1 : i)
        emit(.number, start, i)
        plainStart = i
      } else if Self.isLetter(c) {
        var j = i + 1
        while j < b.count, Self.isLetter(b[j]) { j += 1 }
        let word = String(decoding: b[i..<j], as: UTF8.self)
        if word == "true" || word == "false" || word == "null" {
          emit(.plain, plainStart, start)
          emit(.literal, start, j)
          plainStart = j
        }
        i = j
      } else {
        i += 1
      }
    }
    emit(.plain, plainStart, b.count)
  }

  // MARK: YAML (and TOML, INI)

  mutating func yaml() {
    while i < b.count {
      let lineStart = i
      let end = lineEnd(from: i)
      yamlLine(lineStart, end)
      i = end
      if i < b.count {
        emit(.plain, i, i + 1)
        i += 1
      }
    }
  }

  private mutating func yamlLine(_ start: Int, _ end: Int) {
    var j = start
    while j < end, b[j] == 0x20 || b[j] == 0x09 { j += 1 }
    emit(.plain, start, j)

    if j < end, b[j] == 0x23 {
      emit(.comment, j, end)
      return
    }
    if starts(with: Array("---".utf8), at: j) || starts(with: Array("...".utf8), at: j), j + 3 >= end || Self.isSpace(b[j + 3]) {
      emit(.meta, j, min(j + 3, end))
      yamlValue(min(j + 3, end), end)
      return
    }
    // A section header of INI and TOML: [name].
    if j < end, b[j] == 0x5B, let close = (j..<end).first(where: { b[$0] == 0x5D }) {
      let tail = close + 1
      if (tail..<end).allSatisfy({ Self.isSpace(b[$0]) }) {
        emit(.tag, j, tail)
        emit(.plain, tail, end)
        return
      }
    }
    // A list marker.
    while j < end, b[j] == 0x2D, j + 1 >= end || b[j + 1] == 0x20 {
      emit(.plain, j, min(j + 2, end))
      j = min(j + 2, end)
      while j < end, b[j] == 0x20 { emit(.plain, j, j + 1); j += 1 }
    }
    // A key: a word, or a quoted string, then a colon (or `=` in INI and TOML).
    if let keyEnd = yamlKeyEnd(j, end) {
      emit(.property, j, keyEnd)
      var k = keyEnd
      while k < end, b[k] == 0x20 || b[k] == 0x09 { k += 1 }
      emit(.plain, keyEnd, min(k + 1, end))
      yamlValue(min(k + 1, end), end)
      return
    }
    yamlValue(j, end)
  }

  private func yamlKeyEnd(_ start: Int, _ end: Int) -> Int? {
    guard start < end else { return nil }
    var j = start
    if b[j] == 0x22 || b[j] == 0x27 {
      let quote = b[j]
      j += 1
      while j < end, b[j] != quote { j += 1 }
      guard j < end else { return nil }
      j += 1
    } else {
      while j < end, b[j] != 0x3A, b[j] != 0x3D, b[j] != 0x23, !(b[j] == 0x20 && at(j + 1) == 0x23) {
        j += 1
      }
      guard j < end else { return nil }
      // Trim spaces before the colon.
      var k = j
      while k > start, b[k - 1] == 0x20 || b[k - 1] == 0x09 { k -= 1 }
      guard k > start else { return nil }
      j = k
    }
    var k = j
    while k < end, b[k] == 0x20 || b[k] == 0x09 { k += 1 }
    guard k < end, b[k] == 0x3A || b[k] == 0x3D else { return nil }
    // A colon must be followed by a space or the end of the line (`http://x` is a value).
    if b[k] == 0x3A, k + 1 < end, b[k + 1] != 0x20, b[k + 1] != 0x09 { return nil }
    return j
  }

  private mutating func yamlValue(_ start: Int, _ end: Int) {
    var j = start
    var plainStart = start
    while j < end {
      let c = b[j]
      if c == 0x23, j == start || b[j - 1] == 0x20 || b[j - 1] == 0x09 {
        emit(.plain, plainStart, j)
        emit(.comment, j, end)
        return
      }
      if c == 0x22 || c == 0x27 {
        emit(.plain, plainStart, j)
        var k = j + 1
        while k < end, b[k] != c {
          if c == 0x22, b[k] == 0x5C { k += 1 }
          k += 1
        }
        k = min(k + 1, end)
        emit(.string, j, k)
        j = k
        plainStart = j
        continue
      }
      if Self.isWordStart(c) || Self.isDigit(c) || c == 0x2D || c == 0x26 || c == 0x2A || c == 0x21 {
        var k = j + 1
        while k < end, !Self.isSpace(b[k]), b[k] != 0x2C, b[k] != 0x5D, b[k] != 0x7D, b[k] != 0x23 { k += 1 }
        let word = String(decoding: b[j..<k], as: UTF8.self)
        var kind: CodeTokenKind = .plain
        let lowered = word.lowercased()
        if ["true", "false", "null", "yes", "no", "on", "off", "~"].contains(lowered) {
          kind = .literal
        } else if Double(word.replacingOccurrences(of: "_", with: "")) != nil || (word.hasPrefix("0x") && word.count > 2) {
          kind = .number
        } else if c == 0x26 || c == 0x2A {
          kind = .attribute
        } else if c == 0x21 {
          kind = .type
        }
        if kind != .plain {
          emit(.plain, plainStart, j)
          emit(kind, j, k)
          plainStart = k
        }
        j = k
        continue
      }
      j += 1
    }
    emit(.plain, plainStart, end)
  }

  // MARK: Diff

  mutating func diff() {
    while i < b.count {
      let start = i
      let end = lineEnd(from: i)
      let kind: CodeTokenKind
      if starts(with: Array("+++".utf8), at: start) || starts(with: Array("---".utf8), at: start)
        || starts(with: Array("diff ".utf8), at: start) || starts(with: Array("index ".utf8), at: start)
      {
        kind = .meta
      } else if starts(with: Array("@@".utf8), at: start) {
        kind = .type
      } else if at(start) == 0x2B {
        kind = .addition
      } else if at(start) == 0x2D {
        kind = .deletion
      } else {
        kind = .plain
      }
      emit(kind, start, end)
      i = end
      if i < b.count {
        emit(.plain, i, i + 1)
        i += 1
      }
    }
  }

  // MARK: HTML and XML

  mutating func html() {
    var plainStart = 0
    while i < b.count {
      let start = i
      if b[i] == 0x3C {
        if starts(with: Array("<!--".utf8), at: i) {
          emit(.plain, plainStart, start)
          var j = i + 4
          while j < b.count, !starts(with: Array("-->".utf8), at: j) { j += 1 }
          i = min(j + 3, b.count)
          emit(.comment, start, i)
          plainStart = i
          continue
        }
        if let next = at(i + 1), Self.isLetter(next) || next == 0x2F || next == 0x21 || next == 0x3F {
          emit(.plain, plainStart, start)
          i = htmlTag(from: i)
          plainStart = i
          continue
        }
      }
      i += 1
    }
    emit(.plain, plainStart, b.count)
  }

  /// One tag (or doctype or processing instruction) starting at `start`; returns where it ends.
  private mutating func htmlTag(from start: Int) -> Int {
    var j = start + 1
    if at(j) == 0x2F || at(j) == 0x21 || at(j) == 0x3F { j += 1 }
    emit(.plain, start, start + 1)
    emit(.plain, start + 1, j)
    let nameStart = j
    while j < b.count, Self.isWord(b[j]) || b[j] == 0x2D || b[j] == 0x3A || b[j] == 0x2E { j += 1 }
    emit(.tag, nameStart, j)
    var plainStart = j
    while j < b.count {
      let c = b[j]
      if c == 0x3E {
        emit(.plain, plainStart, j + 1)
        return j + 1
      }
      if c == 0x22 || c == 0x27 {
        emit(.plain, plainStart, j)
        var k = j + 1
        while k < b.count, b[k] != c { k += 1 }
        k = min(k + 1, b.count)
        emit(.string, j, k)
        j = k
        plainStart = j
        continue
      }
      if Self.isWordStart(c) {
        var k = j + 1
        while k < b.count, Self.isWord(b[k]) || b[k] == 0x2D || b[k] == 0x3A || b[k] == 0x2E || b[k] == 0x40 { k += 1 }
        emit(.plain, plainStart, j)
        emit(.property, j, k)
        j = k
        plainStart = j
        continue
      }
      j += 1
    }
    emit(.plain, plainStart, j)
    return j
  }

  // MARK: CSS

  mutating func css() {
    var depth = 0
    var plainStart = 0
    while i < b.count {
      let c = b[i]
      let start = i
      if c == 0x2F, at(i + 1) == 0x2A {
        emit(.plain, plainStart, start)
        i = blockCommentEnd(from: i, block: (Array("/*".utf8), Array("*/".utf8)), nested: false)
        emit(.comment, start, i)
        plainStart = i
      } else if c == 0x22 || c == 0x27 {
        emit(.plain, plainStart, start)
        i = stringEnd(from: i, spec: LanguageSpec())
        emit(.string, start, i)
        plainStart = i
      } else if c == 0x7B {
        depth += 1
        i += 1
      } else if c == 0x7D {
        depth = max(0, depth - 1)
        i += 1
      } else if c == 0x40, let next = at(i + 1), Self.isLetter(next) {
        emit(.plain, plainStart, start)
        var j = i + 1
        while j < b.count, Self.isWord(b[j]) || b[j] == 0x2D { j += 1 }
        i = j
        emit(.keyword, start, i)
        plainStart = i
      } else if c == 0x23, let next = at(i + 1), depth > 0, (Self.isDigit(next) || Self.isLetter(next)) {
        // A colour: #fff, #a1b2c3.
        var j = i + 1
        while j < b.count, Self.isDigit(b[j]) || (b[j] | 0x20 >= 0x61 && b[j] | 0x20 <= 0x66) { j += 1 }
        emit(.plain, plainStart, start)
        i = j
        emit(.number, start, i)
        plainStart = i
      } else if Self.isDigit(c) || (c == 0x2E && at(i + 1).map(Self.isDigit) == true && depth > 0)
        || (c == 0x2D && depth > 0 && at(i + 1).map({ Self.isDigit($0) || $0 == 0x2E }) == true && (i == 0 || !Self.isWord(b[i - 1])))
      {
        emit(.plain, plainStart, start)
        var j = c == 0x2D ? i + 1 : i
        while j < b.count, Self.isDigit(b[j]) || b[j] == 0x2E { j += 1 }
        while j < b.count, Self.isLetter(b[j]) || b[j] == 0x25 { j += 1 }
        i = j
        emit(.number, start, i)
        plainStart = i
      } else if Self.isWordStart(c) || c == 0x2D || c == 0x2E || c == 0x23 || c == 0x3A || c == 0x2A {
        // A word: inside braces, a property before a colon, a value otherwise; outside, a selector.
        var j = i
        if depth == 0 {
          // A selector runs to the next `{`, `,` or space; a class or an id starts with `.` or `#`.
          j = i + 1
          while j < b.count, Self.isWord(b[j]) || b[j] == 0x2D { j += 1 }
          // `min-width: 10px` inside a media query is a property; `a:hover` is a selector.
          if at(j) == 0x3A, at(j + 1) == 0x20 {
            emit(.plain, plainStart, start)
            emit(.property, start, j)
            i = j
            plainStart = i
            continue
          }
          while j < b.count, Self.isWord(b[j]) || b[j] == 0x2D || b[j] == 0x3A { j += 1 }
          emit(.plain, plainStart, start)
          let first = c
          emit(first == 0x3A || first == 0x2A ? .plain : .tag, start, j)
          i = j
          plainStart = i
        } else {
          while j < b.count, Self.isWord(b[j]) || b[j] == 0x2D { j += 1 }
          if j == i {
            i += 1
            continue
          }
          var k = j
          while k < b.count, b[k] == 0x20 || b[k] == 0x09 { k += 1 }
          if at(k) == 0x3A, at(k + 1) != 0x3A, isPropertyContext(at: i) {
            emit(.plain, plainStart, start)
            emit(.property, start, j)
            plainStart = j
          } else if at(j) == 0x28 {
            emit(.plain, plainStart, start)
            emit(.function, start, j)
            plainStart = j
          }
          i = j
        }
      } else {
        i += 1
      }
    }
    emit(.plain, plainStart, b.count)
  }

  /// A word inside a rule is a property only at the start of a declaration: after `{`, `;` or a
  /// line break, not after the `:` of another declaration (`a:hover` in a nested selector).
  private func isPropertyContext(at index: Int) -> Bool {
    var j = index
    while j > 0 {
      j -= 1
      let c = b[j]
      if c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D { continue }
      return c == 0x7B || c == 0x3B || c == 0x2F || c == 0x7D
    }
    return true
  }
}
