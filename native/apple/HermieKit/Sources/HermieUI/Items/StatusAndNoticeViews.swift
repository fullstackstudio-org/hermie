import HermieTranscript
import SwiftUI

/// The machine saying what it is doing. `chip` is a centred capsule; `full`
/// (verbose) adds its kind as an eyebrow.
struct StatusLineView: View {
  let item: StatusItem
  let presentation: Presentation

  var body: some View {
    switch presentation {
    case .hiddenPlaceholder:
      EmptyView()
    case .chip, .collapsed:
      ItemChip(text: item.text, systemImage: "info.circle")
        .accessibilityElement(children: .combine)
    case .full:
      VStack(spacing: 2) {
        Text(ItemFormat.statusKindLabel(item.statusKind))
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Text(item.text)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .combine)
    }
  }
}

/// Everything the gateway or the machine put into the chat that nobody typed:
/// command output, model and personality switches, auto-continue, finished
/// processes and delegations, injected `[System: …]` notes, errors.
///
/// Injected rows arrive on the `user` role but are notices here, so they are
/// never drawn as the owner's bubble; they sit centred or on a ledger line in
/// the machine's voice.
struct NoticeItemView: View {
  let item: NoticeItem
  let presentation: Presentation

  @Environment(\.transcriptExpansion) private var expansion
  @Environment(\.transcriptItemActions) private var actions

  /// The kinds that are one quiet sentence in the middle (`SystemLine`).
  private var isSystemLine: Bool {
    switch item.noticeKind {
    case .modelSwitch, .personalitySwitch, .autoContinue, .systemNote: true
    default: false
    }
  }

  var body: some View {
    if presentation == .hiddenPlaceholder {
      EmptyView()
    } else if isSystemLine {
      Text(ItemFormat.firstSentence(item.body.flatMap { $0.isEmpty ? nil : $0 } ?? item.title))
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
    } else if presentation == .chip && item.noticeKind != .error && item.noticeKind != .command {
      ItemChip(text: item.title, systemImage: symbol)
    } else {
      ledger
    }
  }

  private var isError: Bool { item.noticeKind == .error }

  private var symbol: String {
    switch item.noticeKind {
    case .error: "exclamationmark.triangle.fill"
    case .command: "chevron.forward.slash.chevron.backward"
    case .modelSwitch, .personalitySwitch: "arrow.left.arrow.right"
    case .autoContinue: "arrow.clockwise"
    case .processComplete, .asyncDelegationComplete: "checkmark.circle"
    default: "info.circle"
    }
  }

  private var hasBody: Bool {
    !(item.body ?? "").isEmpty || !(item.completions ?? []).isEmpty
  }

  @ViewBuilder private var ledger: some View {
    let box = expansion.box("notice:\(item.id)", default: item.noticeKind == .command || presentation == .full && isError)
    VStack(alignment: .leading, spacing: 8) {
      if hasBody {
        DisclosureHeader(box: box) { title }
        if box.isExpanded { details }
      } else {
        title
      }
    }
    .cardSurface(tint: isError ? .red : nil)
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      if let body = item.body, !body.isEmpty {
        Button(Strings.Chat.Menu.copyText) { actions.copy(body) }
      }
    }
  }

  private var title: some View {
    Label {
      Text(item.title)
        .font(.subheadline.weight(.medium))
        .frame(maxWidth: .infinity, alignment: .leading)
    } icon: {
      Image(systemName: symbol)
        .foregroundStyle(isError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
    }
  }

  @ViewBuilder private var details: some View {
    if let body = item.body, !body.isEmpty {
      Text(body)
        .font(item.noticeKind == .command ? .footnote.monospaced() : .footnote)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    if let completions = item.completions {
      ForEach(Array(completions.enumerated()), id: \.offset) { _, completion in
        VStack(alignment: .leading, spacing: 2) {
          Text(completion.command)
            .font(.footnote.monospaced().weight(.medium))
          FoldableText(text: completion.output, limit: 400, monospaced: true)
            .foregroundStyle(.secondary)
        }
      }
    }
  }
}
