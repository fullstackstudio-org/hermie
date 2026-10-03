import HermieTranscript
import SwiftUI

/// The tool calls between two messages, as one compact group: "5 steps" and
/// what the last one did, which opens to the list of them; each of those opens
/// to its raw arguments and result (`ToolDetails`). A single call is one line
/// of its own, without a count.
///
/// A step is named for what it did ("Ran code", "Moneybird · list ledger
/// accounts"), not by its identifier (`execute_code`, `tool_call`): see
/// `ToolLabel`. The identifiers and the raw payloads stay in the details.
struct ToolGroupView: View {
  let id: String
  let members: [VisibleItem]

  @Environment(\.transcriptExpansion) private var expansion

  /// The calls that draw something: not hidden by the selectors, and not a silent tool that worked.
  private var tools: [(item: ToolItem, presentation: Presentation)] {
    TranscriptRowBuilder.drawnTools(members).map { ($0.item.asTool!, $0.presentation) }
  }

  var body: some View {
    let tools = self.tools
    if tools.isEmpty {
      EmptyView()
    } else if tools.allSatisfy({ $0.presentation == .chip }) {
      // Quiet: one centred chip for the whole run.
      let failed = tools.contains { ToolLabel.failed($0.item) }
      ItemChip(
        text: tools.count == 1 ? ToolLabel.title(tools[0].item) : NativeStrings.Tool.steps(tools.count),
        systemImage: tools.count == 1 ? ToolFamily(name: tools[0].item.name).symbol : "square.stack.3d.up",
        tone: failed ? .danger : .neutral
      )
    } else if tools.count == 1 {
      ToolCard(
        item: tools[0].item,
        box: expansion.box("tool:\(tools[0].item.id)", default: tools[0].presentation == .full),
        failed: ToolLabel.failed(tools[0].item),
        running: ToolLabel.running(tools[0].item)
      )
    } else {
      group(tools)
    }
  }

  private func group(_ tools: [(item: ToolItem, presentation: Presentation)]) -> some View {
    let box = expansion.box("tools:\(id)", default: tools.contains { $0.presentation == .full })
    return VStack(alignment: .leading, spacing: 0) {
      DisclosureHeader(box: box) {
        header(tools.map(\.item))
      }
      if box.isExpanded {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(tools, id: \.item.id) { tool in
            ToolCard(
              item: tool.item,
              box: expansion.box("tool:\(tool.item.id)", default: false),
              failed: ToolLabel.failed(tool.item),
              running: ToolLabel.running(tool.item),
              nested: true
            )
          }
        }
        .padding(.bottom, 6)
      }
    }
    .padding(.horizontal, 12)
    .background(.fill.quaternary, in: .rect(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilityLabel(tools.map(\.item)))
  }

  private func header(_ items: [ToolItem]) -> some View {
    let running = items.contains(where: ToolLabel.running)
    let failures = items.filter(ToolLabel.failed).count
    let total = items.reduce(0.0) { $0 + ($1.durationS ?? 0) }
    return HStack(spacing: 8) {
      Image(systemName: failures > 0 ? "exclamationmark.triangle.fill" : "square.stack.3d.up")
        .foregroundStyle(failures > 0 ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
        .frame(minWidth: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(NativeStrings.Tool.steps(items.count))
          .font(.subheadline.weight(.medium))
        Text(Self.summary(items))
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if running {
        ProgressView()
          .controlSize(.small)
      } else {
        let duration = ItemFormat.duration(total > 0 ? total : nil)
        if !duration.isEmpty {
          Text(duration)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  /// What the steps did, newest last, in one line: "Moneybird · list ledger accounts, Ran code".
  static func summary(_ items: [ToolItem]) -> String {
    var seen: [String] = []
    for item in items {
      let title = ToolLabel.title(item)
      if seen.last != title { seen.append(title) }
    }
    return seen.joined(separator: ", ")
  }

  private func accessibilityLabel(_ items: [ToolItem]) -> String {
    var parts = [NativeStrings.Tool.steps(items.count), Self.summary(items)]
    if items.contains(where: ToolLabel.failed) { parts.append(Strings.Chat.Tool.failed) }
    return parts.joined(separator: ", ")
  }
}

/// What a tool call is called in the transcript: what it did, in words, rather
/// than its identifier.
///
/// - The gateway's generic MCP dispatcher (`tool_call`) says which server and
///   call it ran in its summary ("Moneybird · list ledger accounts"): that is
///   the title, and nothing is repeated under it.
/// - `mcp__server__call` reads as "Server · call".
/// - Running code is "Ran code" (and "Running code" while it runs); the code
///   itself stays in the details rather than under the title.
/// - A command, a file read or write, a search, the browser: a few words for
///   each, the command or the path under them.
/// - Anything else is its own name with the underscores taken out.
enum ToolLabel {
  private static let dispatchers: Set<String> = ["tool_call", "call_tool", "mcp_call", "use_mcp_tool", "mcp_tool"]
  private static let codeRunners: Set<String> = [
    "execute_code", "code_execution", "run_code", "exec_code", "python", "run_python", "code_interpreter", "execute_python"
  ]

  static func failed(_ item: ToolItem) -> Bool {
    item.status == .error || item.isError == true
  }

  static func running(_ item: ToolItem) -> Bool {
    item.status == .running || item.status == .generating
  }

  static func title(_ item: ToolItem) -> String {
    let name = item.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = name.lowercased()
    let busy = running(item)

    if dispatchers.contains(lower) {
      if let summary = item.summary.map(clean), !summary.isEmpty {
        return ItemFormat.preview(summary, limit: 80)
      }
      for key in ["tool", "tool_name", "name"] {
        if case .string(let named)? = item.args?[key], !named.isEmpty {
          return humanized(named)
        }
      }
      return NativeStrings.Tool.usedTool
    }
    if lower.hasPrefix("mcp__") {
      let parts = name.dropFirst(5).components(separatedBy: "__").filter { !$0.isEmpty }
      if let server = parts.first {
        let call = parts.dropFirst().joined(separator: " ")
        let serverName = server.prefix(1).uppercased() + server.dropFirst()
        return call.isEmpty ? serverName : "\(serverName) · \(humanized(call).lowercased())"
      }
    }
    if codeRunners.contains(lower) {
      return busy ? NativeStrings.Tool.runningCode : NativeStrings.Tool.ranCode
    }
    switch ToolFamily(name: name) {
    case .terminal:
      return busy ? NativeStrings.Tool.runningCommand : NativeStrings.Tool.ranCommand
    case .fileRead:
      return lower.contains("search") || lower == "grep" || lower == "glob"
        ? NativeStrings.Tool.searched : NativeStrings.Tool.readFile
    case .fileWrite:
      return NativeStrings.Tool.wroteFile
    case .diff:
      return NativeStrings.Tool.editedFile
    case .search:
      return lower.contains("web") ? NativeStrings.Tool.searchedWeb : NativeStrings.Tool.searched
    case .browser:
      return NativeStrings.Tool.usedBrowser
    case .mcp, .other:
      return humanized(name)
    }
  }

  /// The line under the title: what the call worked on (a command, a path, a query), when the title
  /// does not already say it. Never code: that is in the details.
  static func subtitle(_ item: ToolItem) -> String? {
    let lower = item.name.lowercased()
    if dispatchers.contains(lower) || codeRunners.contains(lower) {
      return running(item) && item.status == .generating ? Strings.Chat.Tool.generating : nil
    }
    if let summary = item.summary.map(clean), !summary.isEmpty { return ItemFormat.preview(summary, limit: 90) }
    if item.status == .running { return Strings.Chat.Tool.running }
    if item.status == .generating { return Strings.Chat.Tool.generating }
    if let context = item.context.map(clean), !context.isEmpty { return ItemFormat.preview(context, limit: 90) }
    return nil
  }

  /// `send_message` → "Send message".
  static func humanized(_ name: String) -> String {
    let words = name.replacingOccurrences(of: "__", with: " ").replacingOccurrences(of: "_", with: " ")
      .replacingOccurrences(of: "-", with: " ").split(separator: " ").joined(separator: " ")
    guard let first = words.first else { return name }
    return first.uppercased() + words.dropFirst()
  }

  private static func clean(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

extension NativeStrings {
  enum Tool {
    /// {count} step(s)
    static func steps(_ count: Int) -> String {
      String(localized: "native.tool.steps", defaultValue: "\(count) steps", table: "Native", bundle: .module)
    }
    /// Ran code
    static var ranCode: String { String(localized: "native.tool.ranCode", table: "Native", bundle: .module) }
    /// Running code
    static var runningCode: String { String(localized: "native.tool.runningCode", table: "Native", bundle: .module) }
    /// Ran a command
    static var ranCommand: String { String(localized: "native.tool.ranCommand", table: "Native", bundle: .module) }
    /// Running a command
    static var runningCommand: String {
      String(localized: "native.tool.runningCommand", table: "Native", bundle: .module)
    }
    /// Read a file
    static var readFile: String { String(localized: "native.tool.readFile", table: "Native", bundle: .module) }
    /// Wrote a file
    static var wroteFile: String { String(localized: "native.tool.wroteFile", table: "Native", bundle: .module) }
    /// Edited a file
    static var editedFile: String { String(localized: "native.tool.editedFile", table: "Native", bundle: .module) }
    /// Searched the web
    static var searchedWeb: String { String(localized: "native.tool.searchedWeb", table: "Native", bundle: .module) }
    /// Searched
    static var searched: String { String(localized: "native.tool.searched", table: "Native", bundle: .module) }
    /// Used the browser
    static var usedBrowser: String { String(localized: "native.tool.usedBrowser", table: "Native", bundle: .module) }
    /// Used a tool
    static var usedTool: String { String(localized: "native.tool.usedTool", table: "Native", bundle: .module) }
  }
}
