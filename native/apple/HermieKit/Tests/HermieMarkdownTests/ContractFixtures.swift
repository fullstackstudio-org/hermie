import Foundation

@testable import HermieMarkdown

/// Plain JSON, compared structurally.
indirect enum JSON: Equatable, CustomStringConvertible {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  init(any value: Any) {
    switch value {
    case let string as String:
      self = .string(string)
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        self = .bool(number.boolValue)
      } else {
        self = .number(number.doubleValue)
      }
    case let array as [Any]:
      self = .array(array.map(JSON.init(any:)))
    case let object as [String: Any]:
      self = .object(object.mapValues(JSON.init(any:)))
    default:
      self = .null
    }
  }

  subscript(key: String) -> JSON? {
    if case .object(let object) = self { return object[key] }
    return nil
  }

  var stringValue: String? {
    if case .string(let string) = self { return string }
    return nil
  }

  var arrayValue: [JSON] {
    if case .array(let array) = self { return array }
    return []
  }

  var description: String {
    switch self {
    case .null: return "null"
    case .bool(let value): return String(value)
    case .number(let value): return value == value.rounded() ? String(Int(value)) : String(value)
    case .string(let value): return value.debugDescription
    case .array(let values): return "[" + values.map(\.description).joined(separator: ", ") + "]"
    case .object(let object):
      return "{" + object.keys.sorted().map { "\($0): \(object[$0]!)" }.joined(separator: ", ") + "}"
    }
  }
}

/// One case of `contract/markdown/<group>.json`.
struct MarkdownFixture {
  let group: String
  let name: String
  let input: String
  let preprocessed: String
  let blocks: JSON

  static let contractDirectory: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // HermieMarkdownTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // HermieKit
    .deletingLastPathComponent()  // apple
    .deletingLastPathComponent()  // native
    .deletingLastPathComponent()  // repository
    .appendingPathComponent("contract/markdown")

  static func load(_ group: String) throws -> [MarkdownFixture] {
    let data = try Data(contentsOf: contractDirectory.appendingPathComponent("\(group).json"))
    let json = JSON(any: try JSONSerialization.jsonObject(with: data))
    return json.arrayValue.map { entry in
      MarkdownFixture(
        group: group,
        name: entry["name"]?.stringValue ?? "",
        input: entry["input"]?.stringValue ?? "",
        preprocessed: entry["preprocessed"]?.stringValue ?? "",
        blocks: entry["blocks"] ?? .array([])
      )
    }
  }
}

/// The neutral shape of `scripts/golden/dump-markdown.ts`, from the Swift model.
enum NeutralShape {
  static func blocks(_ blocks: [MarkdownBlock]) -> JSON {
    .array(blocks.map(block))
  }

  static func block(_ block: MarkdownBlock) -> JSON {
    switch block.kind {
    case .paragraph(let inline):
      return .object(["kind": .string("paragraph"), "inline": self.inline(inline)])
    case .heading(let level, let inline):
      return .object(["kind": .string("heading"), "level": .number(Double(level)), "inline": self.inline(inline)])
    case .list(let list):
      var object: [String: JSON] = [
        "kind": .string("list"),
        "ordered": .bool(list.ordered),
        "items": .array(
          list.items.map { item in
            var entry: [String: JSON] = ["blocks": blocks(item.blocks)]
            if let checked = item.checked { entry["checked"] = .bool(checked) }
            return .object(entry)
          })
      ]
      if list.ordered { object["start"] = .number(Double(list.start)) }
      return .object(object)
    case .quote(let children):
      return .object(["kind": .string("quote"), "blocks": blocks(children)])
    case .table(let table):
      return .object([
        "kind": .string("table"),
        "align": .array(table.alignments.map { $0.map { .string($0.rawValue) } ?? .null }),
        "header": .array(table.header.map(inline)),
        "rows": .array(table.rows.map { .array($0.map(inline)) })
      ])
    case .code(let code):
      var object: [String: JSON] = ["kind": .string("code"), "text": .string(code.text)]
      if let language = code.language { object["language"] = .string(language) }
      return .object(object)
    case .math(let source):
      return .object(["kind": .string("math"), "text": .string(source)])
    case .mermaid(let source):
      return .object(["kind": .string("mermaid"), "text": .string(source)])
    case .rule:
      return .object(["kind": .string("rule")])
    case .html(let text):
      return .object(["kind": .string("html"), "text": .string(text)])
    }
  }

  static func inline(_ inline: MarkdownInline) -> JSON {
    .array(
      inline.runs.map { run in
        var object: [String: JSON] = ["text": .string(run.text)]
        var marks: [String] = []
        if run.traits.contains(.bold) { marks.append("bold") }
        if run.traits.contains(.code) { marks.append("code") }
        if run.traits.contains(.italic) { marks.append("italic") }
        if run.traits.contains(.math) { marks.append("math") }
        if run.traits.contains(.strikethrough) { marks.append("strike") }
        if !marks.isEmpty { object["marks"] = .array(marks.map(JSON.string)) }
        if let link = run.link { object["link"] = .string(link) }
        return .object(object)
      })
  }
}
