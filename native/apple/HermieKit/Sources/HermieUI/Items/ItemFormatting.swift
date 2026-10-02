import Foundation
import HermieTranscript
import SwiftUI

/// The small formatting rules the rows share, ported from the Expo app's
/// `chat-ui/format.ts` and friends so both apps say the same thing.
enum ItemFormat {
  /// `formatDuration`: "4.2s", "12s", "1m 05s", "1h 04m"; empty for nothing.
  static func duration(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite, seconds >= 0 else { return "" }
    if seconds < 10 {
      return "\(jsNumber((seconds * 10).rounded() / 10))s"
    }
    if seconds < 60 {
      return "\(Int(seconds.rounded()))s"
    }
    let totalMinutes = Int(seconds / 60)
    let rest = Int(seconds.truncatingRemainder(dividingBy: 60).rounded())
    if totalMinutes < 60 {
      return "\(totalMinutes)m \(twoDigits(rest))s"
    }
    return "\(totalMinutes / 60)h \(twoDigits(totalMinutes % 60))m"
  }

  /// `formatCount`: "912", "1.2k", "3.4M".
  static func count(_ value: Int?) -> String {
    guard let value else { return "" }
    if value < 1000 { return String(value) }
    if value < 1_000_000 { return "\(jsNumber((Double(value) / 100).rounded() / 10))k" }
    return "\(jsNumber((Double(value) / 100_000).rounded() / 10))M"
  }

  /// `formatClock`: the local "HH:mm" of a Unix time in seconds.
  static func clock(_ ts: Double?) -> String? {
    guard let ts, ts.isFinite, ts > 0 else { return nil }
    return Date(timeIntervalSince1970: ts).formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
  }

  /// `initialFor`: the first character of the trimmed name, upper-cased, or "?".
  static func initial(_ name: String) -> String {
    guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "?" }
    return String(first).uppercased()
  }

  /// `tintIndex`: a stable bucket for a key — `hash * 31 + code unit`, 32-bit —
  /// so the same author always gets the same colour without anyone storing one.
  static func tintIndex(_ key: String, buckets: Int) -> Int {
    guard buckets > 0 else { return 0 }
    var hash: UInt32 = 0
    for unit in key.utf16 {
      hash = hash &* 31 &+ UInt32(unit)
    }
    return Int(hash % UInt32(buckets))
  }

  /// The colours an author can be given. System colours, so they adapt to
  /// light, dark and increased contrast.
  static let authorTints: [Color] = [.blue, .orange, .green, .purple]

  static func authorTint(_ authorID: String) -> Color {
    authorTints[tintIndex(authorID, buckets: authorTints.count)]
  }

  /// `attachmentName`: the file name a `@file:` / `@image:` reference points at.
  static func attachmentName(_ reference: String) -> String {
    var value = Substring(reference)
    for prefix in ["@file:", "@image:"] where value.hasPrefix(prefix) {
      value = value.dropFirst(prefix.count)
      break
    }
    let quotes: Set<Character> = ["\"", "'", "`"]
    if let first = value.first, quotes.contains(first) { value = value.dropFirst() }
    if let last = value.last, quotes.contains(last) { value = value.dropLast() }
    if let slash = value.lastIndex(where: { $0 == "/" || $0 == "\\" }) {
      value = value[value.index(after: slash)...]
    }
    return String(value)
  }

  static func isImageAttachment(_ reference: String) -> Bool {
    reference.hasPrefix("@image:")
  }

  /// A one-line, Markdown-free preview of a longer text, cut at `limit`.
  static func preview(_ text: String, limit: Int) -> String {
    var line = ""
    line.reserveCapacity(min(text.utf8.count, limit + 1))
    var lastWasSpace = false
    for character in text {
      if line.count >= limit {
        return line.trimmingCharacters(in: .whitespaces) + "…"
      }
      if character.isWhitespace || character.isNewline {
        if !lastWasSpace && !line.isEmpty { line.append(" ") }
        lastWasSpace = true
        continue
      }
      if "#*_`>".contains(character) { continue }
      line.append(character)
      lastWasSpace = false
    }
    return line.trimmingCharacters(in: .whitespaces)
  }

  /// The first sentence of `text`, for a system line.
  static func firstSentence(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let end = trimmed.firstIndex(where: { $0 == "." || $0 == "\n" }) else { return trimmed }
    let sentence = trimmed[...end].trimmingCharacters(in: .whitespacesAndNewlines)
    return sentence.hasSuffix("\n") ? String(sentence.dropLast()) : sentence
  }

  /// `statusKind` as a label: separators become spaces, upper-cased.
  static func statusKindLabel(_ kind: String) -> String {
    kind.replacing(/[._-]/, with: " ").uppercased()
  }

  /// A choice the strings do not know, made readable.
  static func readableChoice(_ choice: String) -> String {
    choice.replacingOccurrences(of: "_", with: " ")
  }

  private static func twoDigits(_ value: Int) -> String {
    value < 10 ? "0\(value)" : String(value)
  }

  /// A number as JavaScript prints it: no ".0" on a whole number.
  private static func jsNumber(_ value: Double) -> String {
    value == value.rounded() ? String(Int(value)) : String(value)
  }
}

/// The family a tool belongs to, for its glyph (`tool-render-class.ts`).
enum ToolFamily {
  case terminal, fileRead, fileWrite, diff, search, browser, mcp, other

  private static let fileEdit: Set<String> = ["edit_file", "patch", "write_file"]
  private static let terminalNames: Set<String> = ["bash", "shell", "run_command", "terminal", "exec", "execute_command"]
  private static let fileReadNames: Set<String> = [
    "read_file", "read", "cat_file", "list_files", "glob", "grep", "search_files"
  ]
  private static let searchNames: Set<String> = ["web_search", "search", "web.search", "fetch", "http_fetch", "http.fetch"]
  private static let browserNames: Set<String> = ["browser", "browse", "computer_use", "playwright", "screenshot"]

  /// `toolFamily`, rule for rule.
  init(name: String) {
    let name = name.lowercased()
    if name.contains("__") || name.hasPrefix("mcp") {
      self = .mcp
    } else if Self.fileEdit.contains(name) || name.contains("patch") || name.contains("diff") {
      self = .diff
    } else if Self.terminalNames.contains(name) || name.contains("command") || name.contains("shell") {
      self = .terminal
    } else if Self.fileReadNames.contains(name) || name.hasPrefix("read") || name.contains("file_read") {
      self = .fileRead
    } else if name.hasPrefix("write") || name.contains("file_write") || name.contains("create_file") {
      self = .fileWrite
    } else if Self.browserNames.contains(name) || name.hasPrefix("browser") {
      self = .browser
    } else if Self.searchNames.contains(name) || name.contains("search") || name.contains("fetch") {
      self = .search
    } else {
      self = .other
    }
  }

  var symbol: String {
    switch self {
    case .terminal: "apple.terminal"
    case .fileRead: "doc.text"
    case .fileWrite: "square.and.pencil"
    case .diff: "plusminus"
    case .search: "magnifyingglass"
    case .browser: "globe"
    case .mcp: "puzzlepiece.extension"
    case .other: "gearshape"
    }
  }
}

/// Tools that draw nothing unless they failed (`tool-render-class.ts`).
let silentToolNames: Set<String> = ["todo", "todo_list", "react_to_message"]
