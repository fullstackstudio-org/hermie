/// Every string the Markdown views show or speak, in one place. English for
/// now; the move to the String Catalog happens with the rest of the app's
/// strings.
enum MarkdownStrings {
  static let copy = "Copy"
  static let copied = "Copied"
  static let copyCode = "Copy code"
  static let copySource = "Copy source"
  static let mathematics = "Mathematics"
  static let diagram = "Diagram"
  static let mermaidSource = "Mermaid source"
  static let mermaidDiagram = "Mermaid diagram"
  static let moreOptions = "More options"
  static let showSource = "Show source"
  static let showRendered = "Show rendered"
  static let taskDone = "Done"
  static let taskOpen = "Not done"
  static let bullet = "Bullet"

  static func code(language: String?) -> String {
    guard let language, !language.isEmpty else { return "Code" }
    return "Code, \(language)"
  }

  static func table(columns: Int, rows: Int) -> String {
    "Table, \(columns) \(columns == 1 ? "column" : "columns"), \(rows) \(rows == 1 ? "row" : "rows")"
  }
}
