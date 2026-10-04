import Foundation
import HermieProtocol

/// A `review.diff` request this app can show (`contract/requests/README.md` §7): the changes to ONE
/// file, hunk by hunk, read strictly from the frame.
///
/// Reading is all or nothing. A frame is refused (`Problem`) when anything in it is outside the
/// contract: a hunk that is not an object or has a key this build does not know, an id that is not
/// `h<n>` or repeats, a header that is not `@@ -a,b +c,d @@`, a line without a marker, a line or a
/// header that does not pass `DiffTextRules`, counts in a header that disagree with the lines, an anchor the
/// hunk does not earn, one on a hunk that is not the last, a rename without its old path, a new file
/// with a removed line. The app then answers `4041 cannot_show` and shows none of it: a review of
/// part of a diff would be a review of less than the agent asked.
///
/// The typed views of `ReviewDiffParams` are not used for this: they drop an element that does not
/// convert, and a hunk dropped silently is a hunk nobody reviews.
public struct ReviewDiff: Sendable, Equatable {
  /// What happens to the file.
  public enum Kind: Sendable, Equatable {
    case modify, new, delete, rename
  }

  /// Where `git apply` pins a hunk, whatever the header's line numbers say.
  public enum Anchor: Sendable, Equatable {
    /// The old start is 0 or 1: the hunk must match at the beginning of the file.
    case start
    /// No context line after its last change: it must match at the END of the file.
    case end
    /// Both: a whole-file hunk.
    case both
  }

  /// One line of a hunk.
  public struct Line: Sendable, Equatable {
    public enum Mark: Sendable, Equatable {
      /// A space: unchanged.
      case context
      /// `+`.
      case added
      /// `-`.
      case removed
      /// git's `\ No newline at end of file`, which belongs to the line before it.
      case noNewline
    }

    public let mark: Mark
    /// The line without its marker, verbatim. For `.noNewline` the whole note.
    public let text: String

    public init(mark: Mark, text: String) {
      self.mark = mark
      self.text = text
    }
  }

  /// The `a,b` of a header: the first line and how many lines. A count left out is 1.
  public struct Span: Sendable, Equatable {
    public let start: Int
    public let count: Int
  }

  public struct Hunk: Sendable, Equatable, Identifiable {
    /// `h1`, `h2`, … as the gateway numbered it; what the answer is keyed by.
    public let id: String
    /// The whole header, as sent.
    public let header: String
    /// The function or section the hunk is in: what follows `@@` in the header.
    public let section: String?
    public let old: Span
    public let new: Span
    public let lines: [Line]
    /// Where the hunk is pinned, when it is: what the gateway said, which the lines bear out.
    public let anchor: Anchor?

    /// The lines that are added.
    public var added: Int { lines.filter { $0.mark == .added }.count }
    /// The lines that are removed.
    public var removed: Int { lines.filter { $0.mark == .removed }.count }
    /// The widest line, in columns (a tab runs to its stop), the marker not counted.
    public var widestColumns: Int { lines.map { DiffTextRules.columns(of: $0.text) }.max() ?? 0 }
  }

  /// Why a frame is not shown.
  public enum Problem: Error, Sendable, Equatable {
    case notShowable
    case kindMissingOrUnknown
    case pathInvalid
    case oldPathInvalid
    case noHunks
    case tooManyHunks
    case hunkNotAnObject
    case hunkKeyUnknown(String)
    case hunkIDInvalid
    case hunkIDRepeated(String)
    case headerInvalid(String)
    case linesInvalid(String)
    case lineInvalid(hunk: String, index: Int)
    case countsDisagree(String)
    case noNewlineMisplaced(String)
    case anchorUnknown(String)
    case anchorFalse(String)
    case anchorNotOnLastHunk(String)
    case kindAndLinesDisagree(String)
    case kindAndHeaderDisagree(String)
  }

  public let kind: Kind
  /// The file's path; for a rename the new one. Display text: show it with `DraftText.reveal`.
  public let path: String
  /// A rename's previous path.
  public let oldPath: String?
  public let hunks: [Hunk]

  /// The most hunks a request holds.
  public static let maxHunks = 200
  /// The most lines a hunk holds.
  public static let maxLines = 400
  /// git's note that the file has no final newline.
  public static let noNewlineNote = "\\ No newline at end of file"

  /// Every hunk id of the request, in order.
  public var hunkIDs: [String] { hunks.map(\.id) }

  /// Whether any hunk's line numbers are the agent's alone: no anchor vouches for where it lands.
  public var hasUnanchoredHunks: Bool { hunks.contains { $0.anchor == nil } }

  // MARK: - Reading

  /// The request as the contract has it, or why this app does not show it.
  public static func read(_ params: ReviewDiffParams) -> Result<ReviewDiff, Problem> {
    do {
      return .success(try parse(params.json))
    } catch let problem as Problem {
      return .failure(problem)
    } catch {
      return .failure(.notShowable)
    }
  }

  private static func parse(_ json: JSONObject) throws -> ReviewDiff {
    let kind: Kind

    switch json["kind"]?.stringValue {
    case "modify": kind = .modify
    case "new": kind = .new
    case "delete": kind = .delete
    case "rename": kind = .rename
    default: throw Problem.kindMissingOrUnknown
    }

    guard let path = json["path"]?.stringValue, isPath(path) else {
      throw Problem.pathInvalid
    }

    var oldPath: String?

    switch (kind, json["old_path"]) {
    case (.rename, .string(let old)?) where isPath(old):
      oldPath = old
    case (.rename, _):
      throw Problem.oldPathInvalid
    case (_, nil), (_, .null?):
      oldPath = nil
    default:
      throw Problem.oldPathInvalid
    }

    guard case .array(let raw)? = json["hunks"], !raw.isEmpty else {
      throw Problem.noHunks
    }

    guard raw.count <= maxHunks else {
      throw Problem.tooManyHunks
    }

    var hunks: [Hunk] = []
    var seen: Set<String> = []

    for (index, value) in raw.enumerated() {
      guard case .object(let object) = value else {
        throw Problem.hunkNotAnObject
      }

      let hunk = try parseHunk(object, kind: kind, last: index == raw.count - 1)

      guard seen.insert(hunk.id).inserted else {
        throw Problem.hunkIDRepeated(hunk.id)
      }

      hunks.append(hunk)
    }

    return ReviewDiff(kind: kind, path: path, oldPath: oldPath, hunks: hunks)
  }

  /// A path as the gateway's builder holds it (§7): 1 to 300 code points of one line of verbatim text
  /// (no control, format or hidden character), relative (no leading `/`, no backslash), and no segment
  /// that is empty, `.`, `..`, `.git` in any case, starts or ends with a space, or ends with a dot.
  static func isPath(_ text: String) -> Bool {
    let count = text.unicodeScalars.count

    guard count >= 1, count <= DiffTextRules.maxPathChars, !text.hasPrefix("/"), !text.contains("\\"),
      !text.unicodeScalars.contains(where: { $0 == "\n" || DraftText.isNotVerbatim($0) })
    else {
      return false
    }

    return !text.split(separator: "/", omittingEmptySubsequences: false).contains { segment in
      segment.isEmpty || segment == "." || segment == ".." || segment.lowercased() == ".git"
        || segment.first == " " || segment.last == " " || segment.last == "."
    }
  }

  /// `^h[1-9][0-9]{0,2}$`.
  static func isHunkID(_ text: String) -> Bool {
    let bytes = Array(text.utf8)

    guard bytes.count >= 2, bytes.count <= 4, bytes[0] == UInt8(ascii: "h"), bytes[1] >= 0x31, bytes[1] <= 0x39 else {
      return false
    }

    return bytes.dropFirst(2).allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
  }

  private static func parseHunk(_ object: JSONObject, kind: Kind, last: Bool) throws -> Hunk {
    for key in object.keys where !DiffHunk.knownKeys.contains(key) {
      throw Problem.hunkKeyUnknown(key)
    }

    guard let id = object["id"]?.stringValue, isHunkID(id) else {
      throw Problem.hunkIDInvalid
    }

    guard let header = object["header"]?.stringValue, header.unicodeScalars.count <= DiffTextRules.maxHeaderChars,
      DiffTextRules.isShowable(header), let parsed = parseHeader(header)
    else {
      throw Problem.headerInvalid(id)
    }

    guard case .array(let rawLines)? = object["lines"], !rawLines.isEmpty, rawLines.count <= maxLines else {
      throw Problem.linesInvalid(id)
    }

    var lines: [Line] = []

    for (index, value) in rawLines.enumerated() {
      guard let text = value.stringValue, let line = parseLine(text) else {
        throw Problem.lineInvalid(hunk: id, index: index)
      }

      lines.append(line)
    }

    // The header's counts say how many old (context, removed) and new (context, added) lines there are.
    let context = lines.filter { $0.mark == .context }.count
    let removed = lines.filter { $0.mark == .removed }.count
    let added = lines.filter { $0.mark == .added }.count

    guard parsed.old.count == context + removed, parsed.new.count == context + added else {
      throw Problem.countsDisagree(id)
    }

    // git's no-newline note (§7): only in the last hunk, only directly after the LAST removed line and/or
    // the LAST added line, once per side; after a note no context line follows (and, being after the
    // last line of its side, none of that side). Anywhere else it would glue a line to the next line of
    // the file when the patch is applied, invisibly.
    if lines.contains(where: { $0.mark == .noNewline }) {
      guard last else {
        throw Problem.noNewlineMisplaced(id)
      }

      let lastRemoved = lines.lastIndex { $0.mark == .removed }
      let lastAdded = lines.lastIndex { $0.mark == .added }
      var firstNote: Int?

      for (index, line) in lines.enumerated() where line.mark == .noNewline {
        firstNote = firstNote ?? index

        guard index > 0, index - 1 == lastRemoved || index - 1 == lastAdded else {
          throw Problem.noNewlineMisplaced(id)
        }
      }

      if let firstNote, lines[firstNote...].contains(where: { $0.mark == .context }) {
        throw Problem.noNewlineMisplaced(id)
      }
    }

    // A new file holds only added lines and a deleted one only removed lines, and its header says so:
    // `-0,0` for a new file, `+0,0` for a deleted one.
    if (kind == .new && (context > 0 || removed > 0)) || (kind == .delete && (context > 0 || added > 0)) {
      throw Problem.kindAndLinesDisagree(id)
    }

    if (kind == .new && parsed.old != Span(start: 0, count: 0))
      || (kind == .delete && parsed.new != Span(start: 0, count: 0))
    {
      throw Problem.kindAndHeaderDisagree(id)
    }

    let declared: Anchor?

    switch object["anchor"] {
    case nil, .null?: declared = nil
    case .string("start")?: declared = .start
    case .string("end")?: declared = .end
    case .string("both")?: declared = .both
    default: throw Problem.anchorUnknown(id)
    }

    let earned = anchor(old: parsed.old, lines: lines)

    // What the gateway says about where `git apply` pins the hunk has to be so; and one that is
    // pinned is labelled as such even when the frame left the label out (a client never presents the
    // line numbers of a hunk that lands at the end of the file as its place).
    if let declared, declared != earned {
      throw Problem.anchorFalse(id)
    }

    // Nothing can follow a hunk pinned to the end of the file.
    if !last, earned == .end || earned == .both {
      throw Problem.anchorNotOnLastHunk(id)
    }

    return Hunk(
      id: id, header: header, section: parsed.section, old: parsed.old, new: parsed.new, lines: lines, anchor: earned)
  }

  /// `start` when the old start is 0 or 1, `end` when no context line follows the last change (the
  /// no-newline note aside), `both` for both.
  static func anchor(old: Span, lines: [Line]) -> Anchor? {
    let start = old.start <= 1
    var end = false

    if let lastChange = lines.lastIndex(where: { $0.mark == .added || $0.mark == .removed }) {
      end = !lines[(lastChange + 1)...].contains { $0.mark == .context }
    }

    switch (start, end) {
    case (true, true): return .both
    case (true, false): return .start
    case (false, true): return .end
    case (false, false): return nil
    }
  }

  /// A line: its marker (a space, `+` or `-`) and its text, or exactly git's no-newline note. At most
  /// 500 code points, the text one that passes `DiffTextRules`.
  static func parseLine(_ raw: String) -> Line? {
    if raw == noNewlineNote {
      return Line(mark: .noNewline, text: raw)
    }

    let scalars = raw.unicodeScalars

    guard let first = scalars.first, scalars.count <= DiffTextRules.maxLineChars else {
      return nil
    }

    let mark: Line.Mark

    switch first {
    case " ": mark = .context
    case "+": mark = .added
    case "-": mark = .removed
    default: return nil
    }

    let text = String(String.UnicodeScalarView(scalars.dropFirst()))

    guard DiffTextRules.isShowable(text) else {
      return nil
    }

    return Line(mark: mark, text: text)
  }

  /// `@@ -a[,b] +c[,d] @@` and, after a space, the section text.
  static func parseHeader(_ header: String) -> (old: Span, new: Span, section: String?)? {
    let scalars = Array(header.unicodeScalars)
    var index = 0

    func take(_ literal: String) -> Bool {
      let expected = Array(literal.unicodeScalars)

      guard index + expected.count <= scalars.count, Array(scalars[index..<(index + expected.count)]) == expected else {
        return false
      }

      index += expected.count
      return true
    }

    func number() -> Int? {
      let start = index

      while index < scalars.count, index - start < 9, scalars[index].value >= 0x30, scalars[index].value <= 0x39 {
        index += 1
      }

      guard index > start else { return nil }

      // A tenth digit is too long.
      if index < scalars.count, scalars[index].value >= 0x30, scalars[index].value <= 0x39 {
        return nil
      }

      return Int(String(String.UnicodeScalarView(scalars[start..<index])))
    }

    func span() -> Span? {
      guard let start = number() else { return nil }

      if take(",") {
        guard let count = number() else { return nil }
        return Span(start: start, count: count)
      }

      return Span(start: start, count: 1)
    }

    guard take("@@ -"), let old = span(), take(" +"), let new = span(), take(" @@") else {
      return nil
    }

    if index == scalars.count {
      return (old, new, nil)
    }

    guard take(" ") else { return nil }

    let section = String(String.UnicodeScalarView(scalars[index...]))
    return (old, new, section.isEmpty ? nil : section)
  }

  // MARK: - Answering

  /// The result for `decisions`, which must decide every hunk of the request and no other: `approved`
  /// when at least one hunk is approved, `rejected` when none is (the gateway refuses the other
  /// pairings, `decision:inconsistent`). `nil` when `decisions` is not exactly one entry per hunk, or
  /// when an entry is anything but approved or rejected.
  public func result(for decisions: [String: HunkDecision]) -> ReviewDiffResult? {
    guard Set(decisions.keys) == Set(hunkIDs), decisions.count == hunks.count,
      decisions.values.allSatisfy({ $0 == .approved || $0 == .rejected })
    else {
      return nil
    }

    return ReviewDiffResult.decided(decisions)
  }
}
