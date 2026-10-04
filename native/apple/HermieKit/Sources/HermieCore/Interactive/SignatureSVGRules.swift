import Foundation

/// What the gateway accepts as the SVG of an `input.signature` answer (`contract/requests/README.md` §8),
/// read once it is on disk: an ALLOWLIST of elements, attributes and value grammars, never a list of what is
/// known to be dangerous. A port of the fake gateway's `signature-svg.ts` (itself a port of the fork's
/// `_svg_problem` and `SVG_VALUES`), held to it by the vectors in `Tests/Vectors/signature-svg.json`.
///
/// This app writes its signature with `SignatureSVG` and checks the bytes with this before anything is
/// uploaded: a file the gateway refuses after the request has settled makes the request unavailable for good
/// (`bad_upload`), and the person cannot sign again. So a generator that drifts from the rules fails here, in
/// the app and in its tests, and not at the gateway.
///
/// The reader knows exactly the XML this allowlist can ever accept: an optional declaration at the very start,
/// comments, unprefixed elements with double- or single-quoted attributes, and white space. Everything else (a
/// doctype, an entity, a CDATA section, a processing instruction, a prefix, a second root, text) is refused.
/// Only a word comes back, never a value of the file.
public enum SignatureSVGRules {
  public static let namespace = "http://www.w3.org/2000/svg"
  /// The only elements a drawn signature needs, written WITHOUT a prefix.
  public static let elements: Set<String> = [
    "svg", "g", "path", "polyline", "polygon", "line", "circle", "ellipse", "rect", "title", "desc"
  ]
  public static let maxDepth = 32
  /// A number is at most this many characters, and so is any run of digits, signs, points and `e`.
  public static let maxNumberCharacters = 32

  /// The PNG signature: the first eight bytes of every PNG.
  public static let pngSignature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

  /// Why `data` is not what `mime` says (`type`, as the gateway words it), or nil when the gateway takes it.
  public static func typeProblem(mime: String, data: Data) -> String? {
    if mime == "image/png" {
      return data.starts(with: pngSignature) ? nil : "type"
    }

    guard mime == "image/svg+xml" else {
      return "type"
    }

    return problem(in: data) == nil ? nil : "type"
  }

  /// The word of the first problem of an SVG, or nil for one the gateway takes. A word for a test that wants to
  /// know why; never put in a reply.
  public static func problem(in data: Data) -> String? {
    guard var text = String(validating: data, as: UTF8.self) else {
      return "encoding"
    }

    // A leading byte order mark is fine (a second one is a format character, refused below).
    if text.unicodeScalars.first == "\u{FEFF}" {
      text.unicodeScalars.removeFirst()
    }

    return problem(in: text)
  }

  public static func problem(in text: String) -> String? {
    let scalars = Array(text.unicodeScalars)

    if scalars.contains("&") || containsURL(scalars) {
      return "reference"
    }

    for scalar in scalars where scalar != "\t" && scalar != "\r" && scalar != "\n" {
      switch scalar.properties.generalCategory {
      case .control, .format, .privateUse, .surrogate: return "control"
      default: continue
      }
    }

    var reader = Reader(scalars)

    do {
      try reader.parse()
      return nil
    } catch let refused as Refused {
      return refused.word
    } catch {
      return "xml"
    }
  }

  // MARK: - Value grammars

  /// Whether `value` is a valid value of the attribute `name`; nil when the attribute is not allowed at all.
  static func accepts(attribute name: String, value: String) -> Bool? {
    let scalars = Array(value.unicodeScalars.map(\.value))

    switch name {
    case "xmlns": return value == namespace
    case "version": return value == "1.0" || value == "1.1"
    case "viewBox": return isViewBox(scalars)
    case "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fill-opacity", "opacity",
      "stroke-opacity", "stroke-width", "stroke-miterlimit", "stroke-dashoffset":
      return Grammar.isLength(scalars)
    case "preserveAspectRatio": return isPreserveAspectRatio(value)
    case "transform": return Grammar.isTransform(scalars)
    case "d": return isPathData(scalars, allowCommands: true)
    case "points": return isPathData(scalars, allowCommands: false)
    case "fill", "stroke": return Grammar.isColor(scalars, value)
    case "fill-rule": return value == "nonzero" || value == "evenodd"
    case "stroke-linecap": return value == "butt" || value == "round" || value == "square"
    case "stroke-linejoin": return value == "miter" || value == "round" || value == "bevel"
    case "stroke-dasharray": return value == "none" || Grammar.isDashArray(scalars)
    default: return nil
    }
  }

  private static func isViewBox(_ scalars: [UInt32]) -> Bool {
    var grammar = Grammar(scalars)

    guard grammar.number() else { return false }

    for _ in 0..<3 {
      guard grammar.separators(), grammar.number() else { return false }
    }

    return grammar.atEnd
  }

  private static let aspectAlignments: Set<String> = {
    var all: Set<String> = ["none"]

    for x in ["Min", "Mid", "Max"] {
      for y in ["Min", "Mid", "Max"] {
        all.insert("x\(x)Y\(y)")
      }
    }

    return all
  }()

  private static func isPreserveAspectRatio(_ value: String) -> Bool {
    let parts = value.split(separator: " ", omittingEmptySubsequences: false).map(String.init)

    switch parts.count {
    case 1: return aspectAlignments.contains(parts[0])
    case 2: return aspectAlignments.contains(parts[0]) && (parts[1] == "meet" || parts[1] == "slice")
    default: return false
    }
  }

  private static let pathCommands = Set("MmZzLlHhVvCcSsQqTtAa".unicodeScalars.map(\.value))
  private static let numberCharacters = Set("0123456789.eE+-".unicodeScalars.map(\.value))
  private static let whitespace = Set(" \t\r\n".unicodeScalars.map(\.value))

  /// `d` (command letters, numbers, commas and white space) and `points` (numbers, commas and white space), with
  /// no run of digits, signs, points and `e` longer than a number may be.
  private static func isPathData(_ scalars: [UInt32], allowCommands: Bool) -> Bool {
    var run = 0

    for scalar in scalars {
      if numberCharacters.contains(scalar) {
        run += 1

        if run > maxNumberCharacters {
          return false
        }

        continue
      }

      run = 0

      let allowed = scalar == 0x2C || whitespace.contains(scalar) || (allowCommands && pathCommands.contains(scalar))

      if !allowed {
        return false
      }
    }

    return true
  }

  /// `url(` in any case: a CSS escape can spell it without writing it, so a value is also held to its grammar.
  private static func containsURL(_ scalars: [Unicode.Scalar]) -> Bool {
    let pattern: [UInt32] = [0x75, 0x72, 0x6C, 0x28]  // u r l (
    var index = 0

    while index + pattern.count <= scalars.count {
      var matches = true

      for offset in 0..<pattern.count {
        var value = scalars[index + offset].value

        if value >= 0x41, value <= 0x5A {
          value += 0x20
        }

        if value != pattern[offset] {
          matches = false
          break
        }
      }

      if matches {
        return true
      }

      index += 1
    }

    return false
  }

  /// One refused file, with the word of why.
  private struct Refused: Error {
    let word: String
  }

  // MARK: - The reader

  private struct Reader {
    let text: [Unicode.Scalar]
    var position = 0
    var depth = 0
    var rooted = false
    var stack: [String] = []

    init(_ text: [Unicode.Scalar]) {
      self.text = text
    }

    private func refuse(_ word: String) -> Refused { Refused(word: word) }

    private func isXMLSpace(_ scalar: Unicode.Scalar) -> Bool {
      scalar == " " || scalar == "\t" || scalar == "\r" || scalar == "\n"
    }

    private func isNameStart(_ scalar: Unicode.Scalar) -> Bool {
      (scalar.value >= 0x41 && scalar.value <= 0x5A) || (scalar.value >= 0x61 && scalar.value <= 0x7A) || scalar == "_"
        || scalar == ":"
    }

    private func isNameCharacter(_ scalar: Unicode.Scalar) -> Bool {
      isNameStart(scalar) || (scalar.value >= 0x30 && scalar.value <= 0x39) || scalar == "." || scalar == "-"
    }

    private func has(_ prefix: String, at index: Int) -> Bool {
      var cursor = index

      for scalar in prefix.unicodeScalars {
        guard cursor < text.count, text[cursor] == scalar else { return false }
        cursor += 1
      }

      return true
    }

    private func skipSpace(_ index: inout Int) {
      while index < text.count, isXMLSpace(text[index]) {
        index += 1
      }
    }

    /// At least one XML space, then true.
    private func requireSpace(_ index: inout Int) -> Bool {
      let start = index
      skipSpace(&index)
      return index > start
    }

    private func readName(_ index: inout Int) -> String? {
      guard index < text.count, isNameStart(text[index]) else { return nil }

      var name = String.UnicodeScalarView()

      while index < text.count, isNameCharacter(text[index]) {
        name.append(text[index])
        index += 1
      }

      return String(name)
    }

    private func expect(_ word: String, _ index: inout Int) -> Bool {
      guard has(word, at: index) else { return false }
      index += word.unicodeScalars.count
      return true
    }

    /// `"1.x"` or `'1.x'`.
    private func readVersion(_ index: inout Int) -> Bool {
      guard index < text.count, text[index] == "\"" || text[index] == "'" else { return false }
      let quote = text[index]
      index += 1

      guard expect("1.", &index) else { return false }

      var digits = 0

      while index < text.count, text[index].value >= 0x30, text[index].value <= 0x39 {
        digits += 1
        index += 1
      }

      guard digits > 0, index < text.count, text[index] == quote else { return false }
      index += 1
      return true
    }

    /// The declaration at the very start, with its optional encoding (which must be UTF-8) and standalone.
    private mutating func readDeclaration() throws {
      var cursor = 5  // after `<?xml`

      guard requireSpace(&cursor), expect("version", &cursor) else { throw refuse("xml") }
      skipSpace(&cursor)
      guard expect("=", &cursor) else { throw refuse("xml") }
      skipSpace(&cursor)
      guard readVersion(&cursor) else { throw refuse("xml") }

      var afterSpace = cursor

      if requireSpace(&afterSpace), expect("encoding", &afterSpace) {
        skipSpace(&afterSpace)
        guard expect("=", &afterSpace) else { throw refuse("xml") }
        skipSpace(&afterSpace)

        guard afterSpace < text.count, text[afterSpace] == "\"" || text[afterSpace] == "'" else { throw refuse("xml") }
        let quote = text[afterSpace]
        afterSpace += 1

        var encoding = String.UnicodeScalarView()
        let startIndex = afterSpace

        while afterSpace < text.count, text[afterSpace] != quote {
          let scalar = text[afterSpace]
          let letter = (scalar.value >= 0x41 && scalar.value <= 0x5A) || (scalar.value >= 0x61 && scalar.value <= 0x7A)
          let rest = (scalar.value >= 0x30 && scalar.value <= 0x39) || scalar == "." || scalar == "_" || scalar == "-"

          guard letter || (afterSpace > startIndex && rest) else { throw refuse("xml") }
          encoding.append(scalar)
          afterSpace += 1
        }

        guard afterSpace < text.count, !encoding.isEmpty else { throw refuse("xml") }
        afterSpace += 1

        let name = String(encoding).lowercased()

        guard name == "utf-8" || name == "utf8" else { throw refuse("encoding") }
        cursor = afterSpace
      }

      afterSpace = cursor

      if requireSpace(&afterSpace), expect("standalone", &afterSpace) {
        skipSpace(&afterSpace)
        guard expect("=", &afterSpace) else { throw refuse("xml") }
        skipSpace(&afterSpace)
        guard afterSpace < text.count, text[afterSpace] == "\"" || text[afterSpace] == "'" else { throw refuse("xml") }
        let quote = text[afterSpace]
        afterSpace += 1

        guard expect("yes", &afterSpace) || expect("no", &afterSpace), afterSpace < text.count,
          text[afterSpace] == quote
        else { throw refuse("xml") }
        afterSpace += 1
        cursor = afterSpace
      }

      skipSpace(&cursor)
      guard expect("?>", &cursor) else { throw refuse("xml") }
      position = cursor
    }

    mutating func parse() throws {
      if has("<?xml", at: 0) {
        try readDeclaration()
      }

      while position < text.count {
        if text[position] != "<" {
          try readCharacterData()
          continue
        }

        if has("<!--", at: position) {
          try readComment()
          continue
        }

        if has("<!", at: position) {
          throw refuse(has("<![CDATA[", at: position) ? "cdata" : "doctype")
        }

        if has("<?", at: position) {
          throw refuse("instruction")
        }

        if has("</", at: position) {
          try readEndTag()
          continue
        }

        try readStartTag()
      }

      if depth != 0 || !rooted {
        throw refuse("xml")
      }
    }

    private mutating func readCharacterData() throws {
      var end = position

      while end < text.count, text[end] != "<" {
        end += 1
      }

      // A CDATA section's end outside a CDATA section is not well-formed.
      var index = position

      while index + 2 < end {
        if text[index] == "]", text[index + 1] == "]", text[index + 2] == ">" {
          throw refuse("xml")
        }

        index += 1
      }

      let data = text[position..<end]

      if depth == 0 {
        // Outside the root only XML white space is well-formed.
        if data.contains(where: { !isXMLSpace($0) }) {
          throw refuse("xml")
        }
      } else if data.contains(where: { !DraftText.isSpace($0) }) {
        // A drawn signature has no text: `title` and `desc` may be there, empty.
        throw refuse("text")
      }

      position = end
    }

    private mutating func readComment() throws {
      // The first comment end at or after the body's start; the body is what lies between.
      let start = position + 4
      var found: Int?
      var index = start

      while index + 2 < text.count {
        if text[index] == "-", text[index + 1] == "-", text[index + 2] == ">" {
          found = index
          break
        }

        index += 1
      }

      guard let end = found else { throw refuse("xml") }

      let body = text[start..<end]
      var previousDash = false

      for scalar in body {
        if scalar == "-" {
          if previousDash { throw refuse("xml") }
          previousDash = true
        } else {
          previousDash = false
        }
      }

      if body.last == "-" {
        throw refuse("xml")
      }

      position = end + 3
    }

    private mutating func readEndTag() throws {
      var cursor = position + 2

      guard let name = readName(&cursor) else { throw refuse("xml") }
      skipSpace(&cursor)

      guard cursor < text.count, text[cursor] == ">", depth > 0, stack.popLast() == name else { throw refuse("xml") }

      depth -= 1
      position = cursor + 1
    }

    private mutating func readStartTag() throws {
      var cursor = position + 1

      guard let name = readName(&cursor) else { throw refuse("xml") }

      var attributes: [(key: String, value: String)] = []

      while true {
        var probe = cursor

        guard requireSpace(&probe), let key = readName(&probe) else { break }
        skipSpace(&probe)

        guard probe < text.count, text[probe] == "=" else { break }
        probe += 1
        skipSpace(&probe)

        guard probe < text.count, text[probe] == "\"" || text[probe] == "'" else { break }
        let quote = text[probe]
        probe += 1

        var raw = String.UnicodeScalarView()
        var closed = false

        while probe < text.count {
          let scalar = text[probe]

          if scalar == quote {
            closed = true
            probe += 1
            break
          }

          if scalar == "<" {
            break
          }

          raw.append(scalar)
          probe += 1
        }

        guard closed else { break }

        // A duplicate attribute is not well-formed.
        if attributes.contains(where: { $0.key == key }) {
          throw refuse("xml")
        }

        attributes.append((key, Self.normalised(String(raw))))
        cursor = probe
      }

      skipSpace(&cursor)
      var selfClosing = false

      if cursor < text.count, text[cursor] == "/" {
        selfClosing = true
        cursor += 1
      }

      guard cursor < text.count, text[cursor] == ">" else { throw refuse("xml") }
      cursor += 1

      // Junk after the document element.
      if rooted, depth == 0 {
        throw refuse("xml")
      }

      depth += 1

      if depth > SignatureSVGRules.maxDepth || !SignatureSVGRules.elements.contains(name) || (depth == 1) != (name == "svg") {
        throw refuse("element")
      }

      for (key, value) in attributes {
        guard let valid = SignatureSVGRules.accepts(attribute: key, value: value), !value.unicodeScalars.contains("\\"),
          !Self.containsURL(value)
        else {
          throw refuse("attribute")
        }

        // No white space at either end, for every attribute.
        if let first = value.unicodeScalars.first, isXMLSpace(first) {
          throw refuse("value")
        }

        if let last = value.unicodeScalars.last, isXMLSpace(last) {
          throw refuse("value")
        }

        if key == "xmlns", depth != 1 {
          throw refuse("namespace")
        }

        if !valid {
          throw refuse("value")
        }
      }

      if depth == 1 {
        rooted = true

        if attributes.first(where: { $0.key == "xmlns" })?.value != SignatureSVGRules.namespace {
          throw refuse("namespace")
        }
      }

      if selfClosing {
        depth -= 1
      } else {
        stack.append(name)
      }

      position = cursor
    }

    /// Attribute-value normalisation: every tab, CR and LF (a CR LF pair as one) becomes one space.
    private static func normalised(_ raw: String) -> String {
      var out = String.UnicodeScalarView()
      var previousCR = false

      for scalar in raw.unicodeScalars {
        if scalar == "\n", previousCR {
          previousCR = false
          continue
        }

        previousCR = scalar == "\r"
        out.append(scalar == "\t" || scalar == "\r" || scalar == "\n" ? " " : scalar)
      }

      return String(out)
    }

    private static func containsURL(_ value: String) -> Bool {
      SignatureSVGRules.containsURL(Array(value.unicodeScalars))
    }
  }

  // MARK: - Grammars by hand

  /// A small scanner over the scalars of one attribute value, for the number-shaped grammars.
  private struct Grammar {
    let s: [UInt32]
    var i = 0

    init(_ scalars: [UInt32]) { s = scalars }

    var atEnd: Bool { i == s.count }
    private var peek: UInt32? { i < s.count ? s[i] : nil }

    private static func isDigit(_ value: UInt32?) -> Bool {
      guard let value else { return false }
      return value >= 0x30 && value <= 0x39
    }

    /// `[ \t\r\n]*`.
    mutating func skipWhitespace() {
      while let value = peek, value == 0x20 || value == 0x09 || value == 0x0D || value == 0x0A {
        i += 1
      }
    }

    /// `[ \t\r\n,]+`.
    mutating func separators() -> Bool {
      let start = i

      while let value = peek, value == 0x20 || value == 0x09 || value == 0x0D || value == 0x0A || value == 0x2C {
        i += 1
      }

      return i > start
    }

    /// `(?![0-9.eE+-]{33})[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`
    mutating func number() -> Bool {
      // The lookahead: the next 33 characters are not all digits, signs, points and `e`.
      if i + 33 <= s.count {
        let window = s[i..<(i + 33)]

        if window.allSatisfy({ SignatureSVGRules.numberCharacters.contains($0) }) {
          return false
        }
      }

      let start = i

      if peek == 0x2B || peek == 0x2D {
        i += 1
      }

      var integerDigits = 0

      while Self.isDigit(peek) {
        integerDigits += 1
        i += 1
      }

      if integerDigits > 0 {
        if peek == 0x2E {
          i += 1

          while Self.isDigit(peek) {
            i += 1
          }
        }
      } else if peek == 0x2E {
        i += 1
        var fractionDigits = 0

        while Self.isDigit(peek) {
          fractionDigits += 1
          i += 1
        }

        if fractionDigits == 0 {
          i = start
          return false
        }
      } else {
        i = start
        return false
      }

      if peek == 0x65 || peek == 0x45 {
        let before = i
        i += 1

        if peek == 0x2B || peek == 0x2D {
          i += 1
        }

        var exponentDigits = 0

        while Self.isDigit(peek) {
          exponentDigits += 1
          i += 1
        }

        if exponentDigits == 0 {
          i = before
        }
      }

      return true
    }

    private static let units = ["px", "%", "em", "ex", "pt", "pc", "mm", "cm", "in"].map { Array($0.unicodeScalars.map(\.value)) }

    /// A number with an optional unit.
    mutating func length() -> Bool {
      guard number() else { return false }

      for unit in Self.units where i + unit.count <= s.count && Array(s[i..<(i + unit.count)]) == unit {
        i += unit.count
        break
      }

      return true
    }

    static func isLength(_ scalars: [UInt32]) -> Bool {
      var grammar = Grammar(scalars)
      return grammar.length() && grammar.atEnd
    }

    static func isDashArray(_ scalars: [UInt32]) -> Bool {
      var grammar = Grammar(scalars)

      guard grammar.length() else { return false }

      while !grammar.atEnd {
        guard grammar.separators(), grammar.length() else { return false }
      }

      return true
    }

    private mutating func keyword(_ word: String) -> Bool {
      let scalars = word.unicodeScalars.map(\.value)

      guard i + scalars.count <= s.count, Array(s[i..<(i + scalars.count)]) == scalars else { return false }
      i += scalars.count
      return true
    }

    /// `none`, `currentcolor`, `transparent`, a CSS colour keyword, `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or
    /// `rgb()`/`rgba()` of numbers and percentages.
    static func isColor(_ scalars: [UInt32], _ text: String) -> Bool {
      if SignatureSVGRules.colorKeywords.contains(text) {
        return true
      }

      if scalars.first == 0x23 {
        let digits = scalars.dropFirst()
        let hex = digits.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }
        return hex && [3, 4, 6, 8].contains(digits.count)
      }

      var grammar = Grammar(scalars)

      guard grammar.keyword("rgb") else { return false }
      _ = grammar.keyword("a")
      guard grammar.keyword("(") else { return false }

      grammar.skipWhitespace()
      guard grammar.component() else { return false }

      var more = 0

      while grammar.peek == 0x2C {
        grammar.i += 1
        grammar.skipWhitespace()
        guard grammar.component() else { return false }
        more += 1
      }

      guard (2...3).contains(more), grammar.keyword(")") else { return false }
      return grammar.atEnd
    }

    /// `NUM%?` and the white space after it.
    private mutating func component() -> Bool {
      guard number() else { return false }

      if peek == 0x25 {
        i += 1
      }

      skipWhitespace()
      return true
    }

    private static let transformNames = ["matrix", "translate", "scale", "rotate", "skewX", "skewY"]

    /// One or more of `matrix`, `translate`, `scale`, `rotate`, `skewX`, `skewY` of numbers.
    static func isTransform(_ scalars: [UInt32]) -> Bool {
      var grammar = Grammar(scalars)
      var seen = false

      while true {
        while let value = grammar.peek, value == 0x20 || value == 0x09 || value == 0x0D || value == 0x0A || value == 0x2C {
          grammar.i += 1
        }

        if grammar.atEnd {
          return seen
        }

        guard transformNames.contains(where: { grammar.keyword($0) }) else { return false }
        grammar.skipWhitespace()
        guard grammar.keyword("(") else { return false }
        grammar.skipWhitespace()
        guard grammar.number() else { return false }

        while true {
          let before = grammar.i

          if grammar.separators(), grammar.number() {
            continue
          }

          grammar.i = before
          break
        }

        grammar.skipWhitespace()
        guard grammar.keyword(")") else { return false }
        seen = true
      }
    }
  }

  /// `none`, `currentcolor`, `transparent` and the CSS colour keywords, lowercase only.
  static let colorKeywords: Set<String> = Set(
    """
    none currentcolor transparent aliceblue antiquewhite aqua aquamarine azure beige bisque
    black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson
    cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
    darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
    deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod
    gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
    lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
    lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon
    mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
    mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered
    orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
    rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
    slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
    yellowgreen
    """.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))
}
