import Foundation

/// A file the log can be exported as.
public enum DecisionExportFormat: String, Sendable, CaseIterable, Identifiable {
  case csv
  case json

  public var id: Self { self }

  public var fileExtension: String { rawValue }
}

/**
 The log as a file: what the person sees in the list, in a form a spreadsheet or a script reads.

 Both formats carry the same fields: when (UTC, to the second), gateway, bot, chat (the runtime session the request
 named), kind, outcome, method and summary. Neither carries anything the log does not hold, so neither can leak
 a secret the log never had.

 The CSV follows RFC 4180 (comma, CRLF, a field with a comma, a quote or a line break in quotes, quotes
 doubled) and, because a spreadsheet runs a cell that starts with `=`, `+`, `-`, `@`, a tab or a return as a
 formula, puts an apostrophe in front of such a cell: the text of a command is the bot's, not the person's.
 */
public enum DecisionExport {
  public static let csvHeader = ["time", "gateway", "bot", "chat", "kind", "outcome", "method", "summary"]

  /// The file's contents.
  public static func data(_ entries: [DecisionEntry], as format: DecisionExportFormat, exportedAt: Date = Date()) -> Data {
    switch format {
    case .csv: Data(csv(entries).utf8)
    case .json: json(entries, exportedAt: exportedAt)
    }
  }

  /// `hermie-decisions-2026-10-05.csv`, by the UTC day.
  public static func fileName(_ format: DecisionExportFormat, now: Date = Date()) -> String {
    "hermie-decisions-\(day(now)).\(format.fileExtension)"
  }

  // MARK: CSV

  public static func csv(_ entries: [DecisionEntry]) -> String {
    var lines = [csvHeader.joined(separator: ",")]

    for entry in entries {
      let cells = [
        timestamp(entry.at), entry.gateway, entry.bot, entry.session, entry.kind.rawValue, entry.outcome.rawValue,
        entry.method.rawValue, entry.summary ?? ""
      ]

      lines.append(cells.map(csvCell).joined(separator: ","))
    }

    return lines.joined(separator: "\r\n") + "\r\n"
  }

  static func csvCell(_ raw: String) -> String {
    var text = raw

    if let first = text.unicodeScalars.first, "=+-@\t\r".unicodeScalars.contains(first) {
      text = "'" + text
    }

    guard text.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }) else {
      return text
    }

    return "\"" + text.replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }

  // MARK: JSON

  public static func json(_ entries: [DecisionEntry], exportedAt: Date = Date()) -> Data {
    let rows = entries.map { entry -> [String: String] in
      var row = [
        "time": timestamp(entry.at),
        "gateway": entry.gateway,
        "gateway_id": entry.gatewayID,
        "bot": entry.bot,
        "chat": entry.session,
        "kind": entry.kind.rawValue,
        "outcome": entry.outcome.rawValue,
        "method": entry.method.rawValue
      ]

      if let summary = entry.summary {
        row["summary"] = summary
      }

      return row
    }
    let document: [String: Any] = ["version": 1, "exported_at": timestamp(exportedAt), "entries": rows]

    return
      (try? JSONSerialization.data(
        withJSONObject: document, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]))
      ?? Data("{}".utf8)
  }

  // MARK: Time

  static func timestamp(_ date: Date) -> String {
    date.formatted(.iso8601)
  }

  private static func day(_ date: Date) -> String {
    String(timestamp(date).prefix(10))
  }
}
