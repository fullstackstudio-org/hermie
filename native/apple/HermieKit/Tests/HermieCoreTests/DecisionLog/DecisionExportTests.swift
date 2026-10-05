import Foundation
import Testing

@testable import HermieCore

/// The log as a file.
@Suite("Decision log: export") struct DecisionExportTests {
  private let entries = [
    DecisionFixture.entry(
      "a", at: Date(timeIntervalSince1970: 1_790_000_000), bot: "researcher", kind: .approval, outcome: .approvedAlways,
      summary: "echo \"hi\", there"),
    DecisionFixture.entry(
      "b", at: Date(timeIntervalSince1970: 1_789_990_000), bot: "writer", kind: .confirm, outcome: .confirmed,
      method: .passkey)
  ]

  @Test("the CSV has a header and one row per entry, with CRLF line ends")
  func csv() {
    let text = DecisionExport.csv(entries)
    let lines = text.components(separatedBy: "\r\n")

    #expect(lines.count == 4, "two rows, a header, and the empty piece after the last line end")
    #expect(lines[0] == "time,gateway,bot,chat,kind,outcome,method,summary")
    #expect(lines[1] == "2026-09-21T14:13:20Z,Home,researcher,sess-researcher,approval,approvedAlways,tap,\"echo \"\"hi\"\", there\"")
    #expect(lines[2] == "2026-09-21T11:26:40Z,Home,writer,sess-writer,confirm,confirmed,passkey,")
    #expect(lines[3].isEmpty)
  }

  @Test("a field with a comma, a quote or a line break is quoted, quotes doubled")
  func quoting() {
    #expect(DecisionExport.csvCell("plain") == "plain")
    #expect(DecisionExport.csvCell("a,b") == "\"a,b\"")
    #expect(DecisionExport.csvCell("say \"x\"") == "\"say \"\"x\"\"\"")
    #expect(DecisionExport.csvCell("a\nb") == "\"a\nb\"")
  }

  @Test("a cell a spreadsheet would run as a formula gets an apostrophe in front")
  func formulas() {
    for lead in ["=", "+", "-", "@"] {
      #expect(DecisionExport.csvCell("\(lead)SUM(A1)") == "'\(lead)SUM(A1)")
    }

    #expect(DecisionExport.csvCell("-rf") == "'-rf")
    #expect(DecisionExport.csvCell("=1,2") == "\"'=1,2\"")
    #expect(DecisionExport.csvCell("a=b") == "a=b")
  }

  @Test("the JSON carries the same fields, and the summary only when there is one")
  func json() throws {
    let data = DecisionExport.json(entries, exportedAt: Date(timeIntervalSince1970: 1_790_000_100))
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])

    #expect(object["version"] as? Int == 1)
    #expect(object["exported_at"] as? String == "2026-09-21T14:15:00Z")

    let rows = try #require(object["entries"] as? [[String: String]])

    #expect(rows.count == 2)
    #expect(
      rows[0] == [
        "time": "2026-09-21T14:13:20Z", "gateway": "Home", "gateway_id": "g1", "bot": "researcher",
        "chat": "sess-researcher", "kind": "approval", "outcome": "approvedAlways", "method": "tap",
        "summary": "echo \"hi\", there"
      ])
    #expect(rows[1]["summary"] == nil)
    #expect(rows[1]["method"] == "passkey")
  }

  @Test("the file name is by the UTC day and carries the extension of its format")
  func fileName() {
    let now = Date(timeIntervalSince1970: 1_790_000_000)

    #expect(DecisionExport.fileName(.csv, now: now) == "hermie-decisions-2026-09-21.csv")
    #expect(DecisionExport.fileName(.json, now: now) == "hermie-decisions-2026-09-21.json")
    #expect(DecisionExportFormat.allCases == [.csv, .json])
  }

  @Test("the data of a format is its text")
  func data() {
    #expect(String(decoding: DecisionExport.data(entries, as: .csv), as: UTF8.self) == DecisionExport.csv(entries))
    #expect(!DecisionExport.data(entries, as: .json).isEmpty)
  }

  @Test("an empty log is a header alone, and an empty list")
  func empty() throws {
    #expect(DecisionExport.csv([]) == "time,gateway,bot,chat,kind,outcome,method,summary\r\n")

    let object = try #require(try JSONSerialization.jsonObject(with: DecisionExport.json([])) as? [String: Any])

    #expect((object["entries"] as? [Any])?.isEmpty == true)
  }
}
