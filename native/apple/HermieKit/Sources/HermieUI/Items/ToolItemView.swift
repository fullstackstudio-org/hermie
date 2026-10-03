import HermieProtocol
import HermieTranscript
import SwiftUI

/// A tool call. Collapsed it is one line — glyph, name, what it is doing or
/// did, a spinner or its duration, a chevron; open it is a card with the
/// arguments, the diff, the result and the raw payloads. `full` (verbose)
/// starts open, `collapsed` starts closed, and a tap is remembered per row.
///
/// `todo`, `todo_list` and `react_to_message` draw nothing unless they failed:
/// their output belongs to another surface (`isSilentTool`).
struct ToolItemView: View {
  let item: ToolItem
  let presentation: Presentation

  @Environment(\.transcriptExpansion) private var expansion

  private var failed: Bool { item.status == .error || item.isError == true }
  private var running: Bool { item.status == .running || item.status == .generating }

  var body: some View {
    if presentation == .hiddenPlaceholder || (silentToolNames.contains(item.name) && !failed) {
      EmptyView()
    } else if presentation == .chip {
      ItemChip(text: ToolLabel.title(item), systemImage: ToolFamily(name: item.name).symbol, tone: failed ? .danger : .neutral)
    } else {
      ToolCard(
        item: item,
        box: expansion.box("tool:\(item.id)", default: presentation == .full),
        failed: failed,
        running: running
      )
    }
  }
}

struct ToolCard: View {
  let item: ToolItem
  @Bindable var box: TranscriptExpansion.Box
  let failed: Bool
  let running: Bool
  /// Inside a group, which draws the surface: no card of its own.
  var nested = false

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      DisclosureHeader(box: box) { header }
      if box.isExpanded {
        ToolDetails(item: item, failed: failed, running: running)
      }
    }
    .padding(.horizontal, nested ? 0 : 12)
    .padding(.vertical, nested ? 0 : 2)
    .background(nested ? AnyShapeStyle(.clear) : AnyShapeStyle(.fill.quaternary), in: .rect(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityActions {
      Button(box.isExpanded ? Strings.Chat.Tool.collapse : Strings.Chat.Tool.expand) { box.isExpanded.toggle() }
      if let text = item.resultText ?? ToolDetails.resultSummary(item) {
        Button(Strings.Chat.Menu.copyText) { actions.copy(text) }
      }
    }
  }

  /// One line, except at the accessibility text sizes, where a cut line would hide most of it.
  private var oneLine: Int? { dynamicTypeSize.isAccessibilitySize ? nil : 1 }

  private var header: some View {
    HStack(spacing: 8) {
      Image(systemName: failed ? "exclamationmark.triangle.fill" : ToolFamily(name: item.name).symbol)
        .foregroundStyle(failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
        .frame(minWidth: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(ToolLabel.title(item))
          .font(.subheadline.weight(.medium))
          .lineLimit(oneLine)
          .truncationMode(.middle)
        if let summary = summaryLine {
          Text(summary)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(oneLine)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if running {
        ProgressView()
          .controlSize(.small)
      } else {
        let duration = ItemFormat.duration(item.durationS)
        if !duration.isEmpty {
          Text(duration)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  /// The first that applies: the tool's own summary, running, preparing, its
  /// context, the result in a line.
  private var summaryLine: String? {
    ToolLabel.subtitle(item)
  }

  private var accessibilityLabel: String {
    var parts = [ToolLabel.title(item)]
    if let summaryLine { parts.append(summaryLine) }
    if failed { parts.append(Strings.Chat.Tool.failed) }
    let duration = ItemFormat.duration(item.durationS)
    if !running && !duration.isEmpty { parts.append(duration) }
    return parts.joined(separator: ", ")
  }
}

/// The open card's body.
struct ToolDetails: View {
  let item: ToolItem
  let failed: Bool
  let running: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      // The call as the gateway names it, and what it said about itself, for whoever wants the raw.
      VStack(alignment: .leading, spacing: 2) {
        Text(item.name)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
        if let summary = item.summary, !summary.isEmpty, summary != ToolLabel.title(item) {
          FoldableText(text: summary, limit: 280, monospaced: true)
            .foregroundStyle(.secondary)
        }
      }
      if let risk = item.outputRisk {
        VStack(alignment: .leading, spacing: 4) {
          Label("\(Strings.Chat.Tool.riskTitle) · \(risk.risk)", systemImage: "exclamationmark.shield")
            .font(.footnote.weight(.semibold))
          ForEach(Array(risk.findings.enumerated()), id: \.offset) { _, finding in
            Text(finding).font(.footnote)
          }
          if risk.redacted {
            Text(Strings.Chat.Tool.redacted).font(.footnote).foregroundStyle(.secondary)
          }
        }
        .cardSurface(tint: .orange)
      }
      if let args = item.args, !args.isEmpty {
        section(Strings.Chat.Tool.arguments) {
          Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
            ForEach(args.keys.sorted(), id: \.self) { key in
              GridRow {
                Text(Self.titleCased(key))
                  .foregroundStyle(.secondary)
                  .gridColumnAlignment(.leading)
                FoldableText(text: Self.display(args[key]!), limit: 280, monospaced: true)
              }
            }
          }
          .font(.footnote)
        }
      }
      if let diff = item.inlineDiff, !diff.isEmpty {
        DiffText(diff: diff)
      }
      if failed {
        section(Strings.Chat.Tool.failed) {
          FoldableText(text: Self.resultSummary(item) ?? Strings.Chat.Tool.failed, limit: 600, monospaced: true)
            .foregroundStyle(.red)
        }
      } else if let result = Self.resultSummary(item) {
        section(Strings.Chat.Tool.result) {
          FoldableText(text: result, limit: 600, monospaced: true)
        }
      } else if !item.resultKnown && !running {
        Text(Strings.Chat.Tool.noResult).font(.footnote).foregroundStyle(.secondary)
      }
      if let raw = item.argsText, !raw.isEmpty {
        section(Strings.Chat.Tool.rawArguments) { FoldableText(text: raw, limit: 280, monospaced: true) }
      }
      if let raw = item.resultText, !raw.isEmpty, raw != Self.resultSummary(item) {
        section(Strings.Chat.Tool.rawResult) { FoldableText(text: raw, limit: 280, monospaced: true) }
      }
    }
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(.uppercase)
      content()
    }
  }

  /// The result as a reader wants it: a string as is, an object's own
  /// output/error/result/content field, otherwise compact JSON.
  static func resultSummary(_ item: ToolItem) -> String? {
    guard let result = item.result else { return item.resultText }
    switch result {
    case .string(let text): return text
    case .null: return item.resultText
    case .object(let object):
      for key in ["error", "output", "result", "content", "message", "stdout"] {
        if case .string(let text)? = object[key], !text.isEmpty { return text }
      }
      return display(result)
    default:
      return display(result)
    }
  }

  static func display(_ value: JSONValue) -> String {
    switch value {
    case .string(let text): return text
    case .null: return "null"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number): return number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : String(number)
    case .array, .object:
      // The canonical writer, not `JSONEncoder`, which recurses and crashes on a
      // result nested a few hundred levels deep (docs/native.md).
      return (try? value.canonicalString()) ?? ""
    }
  }

  static func titleCased(_ key: String) -> String {
    key.split(whereSeparator: { $0 == "_" || $0 == "-" })
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }
      .joined(separator: " ")
  }
}

/// Text cut at `limit` characters with Show more / Show less.
struct FoldableText: View {
  let text: String
  let limit: Int
  var monospaced = false

  @State private var open = false

  var body: some View {
    let long = text.count > limit
    VStack(alignment: .leading, spacing: 4) {
      Text(long && !open ? String(text.prefix(limit)) + "…" : text)
        .font(monospaced ? .footnote.monospaced() : .footnote)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      if long {
        Button(open ? Strings.Chat.Tool.showLess : Strings.Chat.Tool.showMore) { open.toggle() }
          .font(.footnote)
          .buttonStyle(.borderless)
      }
    }
  }
}

/// A unified diff, one line per row, added and removed lines tinted.
struct DiffText: View {
  let diff: String

  var body: some View {
    let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).prefix(200)
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
        Text(line.isEmpty ? " " : String(line))
          .font(.caption.monospaced())
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Self.tint(for: line))
      }
    }
    .padding(6)
    .background(.background.secondary, in: .rect(cornerRadius: 8))
    .textSelection(.enabled)
  }

  static func tint(for line: Substring) -> Color {
    if line.hasPrefix("+") && !line.hasPrefix("+++") { return .green.opacity(0.15) }
    if line.hasPrefix("-") && !line.hasPrefix("---") { return .red.opacity(0.15) }
    return .clear
  }
}
