import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for a `review.diff`: the changes to ONE file, hunk by hunk, and the person's decision
/// about each (`contract/requests/README.md` §7).
///
/// What it shows is what would be written, and nothing is dressed up:
///
/// - the file's path and what happens to it (changed, new, deleted, renamed from the old path) above
///   the hunks, as display text with whatever does not show as itself made visible;
/// - every line verbatim, monospaced, one row per line, with its marker in a gutter that stays put
///   while the text scrolls sideways; added and removed lines differ by the marker and a band behind
///   them, never by colour alone; a tab is shown as a marker and the spaces to its stop of 8 columns;
///   a row wider than the view is never wrapped or cut without saying so (an edge fade, a chevron and
///   a note);
/// - where each hunk lands: "Start of the file", "End of the file" or "Whole file" when `git apply`
///   pins it there, whatever its header says; for the end of the file the header's line numbers are
///   not shown at all; a hunk without a pin is shown with its header and a note that its numbers are
///   the agent's;
/// - a decision for every hunk, "approve all" and "reject all" for the whole file, and Send only once
///   every hunk is decided.
struct DiffSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt

  @State private var review: InteractiveDiffModel
  @State private var armed = false

  init(model: InteractiveModel, prompt: InteractivePrompt, diff: ReviewDiff) {
    self.model = model
    self.prompt = prompt
    _review = State(initialValue: InteractiveDiffModel(diff: diff))
  }

  private var diff: ReviewDiff { review.diff }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "plusminus.circle",
      title: NativeStrings.Interactive.titleDiff(model.botName),
      busy: model.isSending
    ) {
      VStack(alignment: .leading, spacing: 16) {
        DiffFileHeader(diff: diff)
        DiffBulkBar(review: review, enabled: !model.isSending)

        if diff.hasUnanchoredHunks {
          Text(NativeStrings.Interactive.Diff.agentsLineNumbers)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("diff.lineNumbersNote")
        }

        LazyVStack(alignment: .leading, spacing: 16) {
          ForEach(Array(diff.hunks.enumerated()), id: \.element.id) { index, hunk in
            DiffHunkCard(
              hunk: hunk,
              number: index + 1,
              total: diff.hunks.count,
              decision: review.decision(of: hunk.id),
              enabled: !model.isSending
            ) { decision in
              review.decide(hunk.id, decision)
            }
          }
        }
      }
    } actions: {
      progress

      InteractiveButtonRow {
        LaterButton(model: model)
        sendButton
      }
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    .onDisappear {
      review.wipe()
    }
  }

  // MARK: Pieces

  /// How many hunks are decided, or how the decisions stand once all of them are.
  private var progress: some View {
    Text(
      review.isComplete
        ? NativeStrings.Interactive.Diff.tally(approved: review.approvedCount, rejected: review.rejectedCount)
        : NativeStrings.Interactive.Diff.progress(decided: review.decidedCount, total: review.hunkCount)
    )
    .font(.callout.weight(.semibold))
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("diff.progress")
  }

  private var sendButton: some View {
    Button {
      send()
    } label: {
      Text(model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.Diff.send)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || model.isSending || !review.canSend)
    .accessibilityHint(review.canSend ? "" : NativeStrings.Interactive.Diff.decideEveryHunk)
    .accessibilityIdentifier(model.hasFailed ? "interactive.retry" : "diff.send")
  }

  private func send() {
    guard armed, !model.isSending, review.canSend else {
      return
    }

    let answer = review.answer

    Task {
      if await model.answer(answer) {
        review.wipe()
      }
    }
  }
}

// MARK: - The file

/// Which file, and what happens to it: above the hunks (contract §7).
struct DiffFileHeader: View {
  let diff: ReviewDiff

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(kind)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.background.secondary, in: .capsule)
        .accessibilityIdentifier("diff.kind")

      if diff.kind == .rename, let old = diff.oldPath {
        pathBlock(label: NativeStrings.Interactive.Diff.renamedFrom, path: old, identifier: "diff.oldPath")
        pathBlock(label: NativeStrings.Interactive.Diff.renamedTo, path: diff.path, identifier: "diff.path")
      } else {
        pathBlock(label: nil, path: diff.path, identifier: "diff.path")
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var kind: String {
    switch diff.kind {
    case .modify: NativeStrings.Interactive.Diff.kindModify
    case .new: NativeStrings.Interactive.Diff.kindNew
    case .delete: NativeStrings.Interactive.Diff.kindDelete
    case .rename: NativeStrings.Interactive.Diff.kindRename
    }
  }

  /// A path is display text: whole, wrapped when it is long, never cut, with characters that do not
  /// show as themselves made visible.
  private func pathBlock(label: String?, path: String, identifier: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      if let label {
        Text(label)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Text(verbatim: DraftText.reveal(path))
        .font(.callout.monospaced().weight(.semibold))
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .accessibilityIdentifier(identifier)
    }
    .accessibilityElement(children: .combine)
  }
}

/// "Approve all" and "reject all": they set every hunk, which can then be changed one by one. They
/// do not send.
struct DiffBulkBar: View {
  let review: InteractiveDiffModel
  let enabled: Bool

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 10) { buttons }
      VStack(spacing: 10) { buttons }
    }
  }

  @ViewBuilder private var buttons: some View {
    Button {
      review.decideAll(.approved)
    } label: {
      Label(NativeStrings.Interactive.Diff.approveAll, systemImage: "checkmark.circle")
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .disabled(!enabled)
    .accessibilityIdentifier("diff.approveAll")

    Button {
      review.decideAll(.rejected)
    } label: {
      Label(NativeStrings.Interactive.Diff.rejectAll, systemImage: "xmark.circle")
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .disabled(!enabled)
    .accessibilityIdentifier("diff.rejectAll")
  }
}

// MARK: - A hunk

/// One hunk: where it lands, its lines, and the person's decision about it.
struct DiffHunkCard: View {
  let hunk: ReviewDiff.Hunk
  let number: Int
  let total: Int
  let decision: HunkDecision?
  let enabled: Bool
  let decide: (HunkDecision) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(NativeStrings.Interactive.Diff.hunkTitle(number, of: total))
          .font(.subheadline.weight(.semibold))
          .accessibilityAddTraits(.isHeader)

        DiffHunkPlace(hunk: hunk)

        Text(NativeStrings.Interactive.Diff.hunkStats(added: hunk.added, removed: hunk.removed))
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      DiffLinesView(hunk: hunk)

      HStack(spacing: 10) {
        decisionButton(.approved, symbol: "checkmark", tint: .green)
        decisionButton(.rejected, symbol: "xmark", tint: .red)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background.secondary, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("diff.hunk.\(hunk.id)")
  }

  private func decisionButton(_ choice: HunkDecision, symbol: String, tint: Color) -> some View {
    let selected = decision == choice
    let title = choice == .approved ? NativeStrings.Interactive.Diff.approve : NativeStrings.Interactive.Diff.reject
    let spoken =
      choice == .approved
      ? NativeStrings.Interactive.Diff.approveHunk(number) : NativeStrings.Interactive.Diff.rejectHunk(number)

    return Button {
      decide(choice)
    } label: {
      Label(title, systemImage: symbol)
        .font(.body.weight(.semibold))
        .frame(maxWidth: .infinity, minHeight: 32)
    }
    .buttonStyle(.bordered)
    .tint(selected ? tint : nil)
    .background(selected ? tint.opacity(0.18) : .clear, in: .capsule)
    .overlay {
      if selected {
        Capsule().stroke(tint, lineWidth: 2)
      }
    }
    .disabled(!enabled)
    .accessibilityLabel(spoken)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("diff.hunk.\(hunk.id).\(choice.rawValue)")
  }
}

/// Where the hunk lands. A hunk `git apply` pins to the start or the end of the file says so, whatever
/// its header's numbers are; for the end of the file the numbers are not shown at all, because the
/// change goes after the LAST line of the file wherever they point. A hunk without a pin shows its
/// header as it is: its numbers are the agent's.
struct DiffHunkPlace: View {
  let hunk: ReviewDiff.Hunk

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let label {
        Text(label)
          .font(.callout.weight(.semibold))
          .accessibilityIdentifier("diff.anchor")
      }

      if let detail {
        // The header's section text may hold tabs too (§7.1): drawn as in a line, never hidden.
        Text(DiffLinesView.attributed(detail))
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("diff.header")
      }
    }
    .accessibilityElement(children: .combine)
  }

  /// "Start of the file", "End of the file" or "Whole file".
  var label: String? {
    switch hunk.anchor {
    case .start?: NativeStrings.Interactive.Diff.anchorStart
    case .end?: NativeStrings.Interactive.Diff.anchorEnd
    case .both?: NativeStrings.Interactive.Diff.anchorBoth
    case nil: nil
    }
  }

  /// The header, but for the end of the file: there only the section it is in.
  var detail: String? {
    Self.detail(for: hunk)
  }

  static func detail(for hunk: ReviewDiff.Hunk) -> String? {
    switch hunk.anchor {
    case .end?: hunk.section
    default: hunk.header
    }
  }
}

// MARK: - The lines

/// A hunk's lines: a gutter with the markers, and the text beside it, scrolling sideways when a row is
/// wider than the view. Rows do not wrap. When the text is wider than the view, the edge that has more
/// to read fades, a chevron sits at it and a note says so.
struct DiffLinesView: View {
  let hunk: ReviewDiff.Hunk

  @ScaledMetric(relativeTo: .callout) private var rowHeight: CGFloat = 24
  @ScaledMetric(relativeTo: .callout) private var gutterWidth: CGFloat = 26
  @State private var viewport: CGFloat = 0
  @State private var content: CGFloat = 0
  @State private var offset: CGFloat = 0
  /// The height each row has come out at, by line index: the gutter's cells match them.
  @State private var heights: [Int: CGFloat] = [:]

  /// Some row is wider than the view.
  private var overflows: Bool { content > viewport + 1 }
  private var moreRight: Bool { overflows && content - (offset + viewport) > 1 }
  private var moreLeft: Bool { overflows && offset > 1 }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 0) {
        gutter
        scroller
      }
      .clipShape(.rect(cornerRadius: 8))
      .overlay {
        RoundedRectangle(cornerRadius: 8).stroke(.separator, lineWidth: 1)
      }

      if overflows {
        Label(NativeStrings.Interactive.Diff.overflowNote, systemImage: "arrow.left.and.right")
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("diff.overflow")
      }
    }
  }

  /// The markers, apart from the text and always in view.
  private var gutter: some View {
    VStack(spacing: 0) {
      ForEach(Array(hunk.lines.enumerated()), id: \.offset) { index, line in
        Text(verbatim: Self.symbol(line.mark))
          .font(.callout.monospaced().weight(.bold))
          .frame(width: gutterWidth, height: max(rowHeight, heights[index] ?? 0))
          .background(Self.tint(line.mark).opacity(0.28))
          .accessibilityHidden(true)
      }
    }
    .background(.background.secondary)
  }

  private var scroller: some View {
    ScrollView(.horizontal) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        ForEach(Array(hunk.lines.enumerated()), id: \.offset) { index, line in
          GridRow {
            row(index, line)
          }
        }
      }
      .frame(minWidth: viewport, alignment: .leading)
      .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { content = $0 }
    }
    .scrollIndicators(.visible)
    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { viewport = $0 }
    .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.x }) { _, x in offset = x }
    .mask(edgeFade)
    .overlay(alignment: .trailing) {
      if moreRight {
        Image(systemName: "chevron.compact.right")
          .font(.title3.weight(.bold))
          .foregroundStyle(.secondary)
          .padding(.trailing, 2)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
          .accessibilityIdentifier("diff.moreRight")
      }
    }
    .overlay(alignment: .leading) {
      if moreLeft {
        Image(systemName: "chevron.compact.left")
          .font(.title3.weight(.bold))
          .foregroundStyle(.secondary)
          .padding(.leading, 2)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
      }
    }
  }

  /// The text fades at an edge that has more to read beyond it.
  private var edgeFade: some View {
    HStack(spacing: 0) {
      LinearGradient(
        colors: [.black.opacity(moreLeft ? 0.15 : 1), .black], startPoint: .leading, endPoint: .trailing
      )
      .frame(width: 26)
      Rectangle()
      LinearGradient(
        colors: [.black, .black.opacity(moreRight ? 0.15 : 1)], startPoint: .leading, endPoint: .trailing
      )
      .frame(width: 26)
    }
  }

  private func row(_ index: Int, _ line: ReviewDiff.Line) -> some View {
    Text(Self.attributed(line.text))
      .font(.callout.monospaced())
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 8)
      // A row is at least `rowHeight` and grows with its text (a fallback font for a wide glyph, a large
      // text size); the gutter cell of the same row takes the height measured here, so the two columns
      // always line up.
      .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
      .background(Self.tint(line.mark).opacity(0.14))
      .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height in
        if heights[index] != height {
          heights[index] = height
        }
      }
      .accessibilityLabel(Self.spoken(line))
  }

  // MARK: Words and looks

  /// The marker in the gutter: nothing for an unchanged line, `+`, a minus sign, and a backslash for
  /// git's no-newline note.
  static func symbol(_ mark: ReviewDiff.Line.Mark) -> String {
    switch mark {
    case .context: " "
    case .added: "+"
    case .removed: "\u{2212}"
    case .noNewline: "\\"
    }
  }

  static func tint(_ mark: ReviewDiff.Line.Mark) -> Color {
    switch mark {
    case .added: .green
    case .removed: .red
    case .context, .noNewline: .clear
    }
  }

  /// The line's text with its tabs drawn as a marker and the spaces to their stop.
  static func attributed(_ text: String) -> AttributedString {
    var out = AttributedString()

    for piece in DiffTextRules.pieces(text) {
      switch piece {
      case .text(let run):
        out += AttributedString(run)
      case .tab(let width):
        var marker = AttributedString(String(DiffTextRules.tabMarker))
        marker.foregroundColor = .secondary
        out += marker
        out += AttributedString(String(repeating: " ", count: max(0, width - 1)))
      }
    }

    return out
  }

  /// What VoiceOver reads for a row: what happened to the line, then the line, with tabs named.
  static func spoken(_ line: ReviewDiff.Line) -> String {
    typealias Words = NativeStrings.Interactive.Diff

    if line.mark == .noNewline {
      return Words.noNewline
    }

    let what: String

    switch line.mark {
    case .added: what = Words.lineAdded
    case .removed: what = Words.lineRemoved
    default: what = Words.lineUnchanged
    }

    let text =
      line.text.isEmpty ? Words.lineEmpty : line.text.replacingOccurrences(of: "\t", with: " \(Words.tabWord) ")

    return "\(what): \(text)"
  }
}
