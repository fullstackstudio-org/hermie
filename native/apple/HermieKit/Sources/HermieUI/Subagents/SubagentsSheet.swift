import HermieCore
import HermieTranscript
import SwiftUI

/**
 The agents bar expanded: the delegation tree, what each child is doing, and the three things that can
 be done to a running child. Steer is a text field, because a correction is prose and `subagent.steer`
 takes the words as written. Stop ends one child. A child's transcript opens as a page of the sheet:
 the live tail while it runs, and, for a finished child that has a session of its own, that session in
 the conversation viewer behind the sheet.

 Everything a child or the gateway says here (goals, tool names, the stream, the tail, error words) is
 untrusted text and is drawn as plain text, never Markdown.
 */
struct SubagentsSheet: View {
  let chat: ChatRef
  let model: ChatModel

  @State private var panel: SubagentPanelModel
  @Environment(\.dismiss) private var dismiss
  @Environment(AppRouter.self) private var router: AppRouter?

  init(chat: ChatRef, model: ChatModel) {
    self.chat = chat
    self.model = model
    _panel = State(initialValue: model.subagentPanel())
  }

  var body: some View {
    NavigationStack {
      Group {
        if let tail = panel.tail {
          SubagentTailPage(tail: tail)
            .navigationTitle(Strings.Chat.Subagents.transcriptTitle(goal: tail.goal))
        } else {
          list
            .navigationTitle(Strings.Chat.Subagents.title)
        }
      }
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        if panel.tail != nil {
          ToolbarItem(placement: .cancellationAction) {
            Button(Strings.Chat.Subagents.transcriptBack) { panel.closeTail() }
              .accessibilityIdentifier("hermie.agents.back")
          }
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.App.Common.done) { dismiss() }
            .accessibilityIdentifier("hermie.agents.done")
        }
      }
      .task(id: panel.tail?.id) {
        await panel.followTail()
      }
    }
    #if os(macOS)
      .frame(minWidth: 480, minHeight: 520)
    #endif
    .accessibilityIdentifier("hermie.agents")
  }

  private var list: some View {
    List {
      if let notice = panel.notice {
        Section {
          Text(verbatim: SubagentText.notice(notice))
            .font(.callout)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("hermie.agents.notice")
        }
      }

      if model.subagents.isEmpty {
        Text(Strings.Chat.Subagents.idle)
          .foregroundStyle(.secondary)
      } else {
        ForEach(model.subagents) { row in
          SubagentRowView(row: row, panel: panel, openStored: { openStored(row) })
            .listRowInsets(
              EdgeInsets(top: 8, leading: 16 + CGFloat(min(row.depth, 6)) * 16, bottom: 8, trailing: 16))
        }
      }
    }
  }

  /// A finished child's own session, read in the conversation viewer behind this sheet.
  private func openStored(_ row: SubagentRow) {
    guard let session = row.childSession else {
      return
    }

    dismiss()
    router?.showConversation(chat, id: session, resolvedID: session, title: row.subagent.goal)
  }
}

/// One child: its goal and state, what it is doing, and its actions.
struct SubagentRowView: View {
  let row: SubagentRow
  let panel: SubagentPanelModel
  let openStored: () -> Void

  @State private var steering = false
  @State private var draft = ""

  var body: some View {
    let child = row.subagent
    let busy = panel.busy.contains(row.id)

    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: SubagentText.symbol(child.status))
          .foregroundStyle(tone(child.status))
          .accessibilityHidden(true)

        Text(verbatim: child.goal)
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading)

        Text(verbatim: SubagentBar.clock(child.durationSeconds ?? max(0, (child.updatedAt - child.startedAt) / 1000)))
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 8) {
        Text(verbatim: SubagentText.status(child.status))
          .font(.caption.weight(.semibold))
          .foregroundStyle(tone(child.status))

        if let tool = child.currentTool, !tool.isEmpty {
          Text(verbatim: tool)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }

      ForEach(Array(child.stream.suffix(4).enumerated()), id: \.offset) { _, entry in
        Text(verbatim: entry.text)
          .font(.caption)
          .foregroundStyle(entry.isError == true ? Color.red : Color.secondary)
          .lineLimit(2)
      }

      if let summary = child.summary, !summary.isEmpty {
        Text(verbatim: summary)
          .font(.footnote)
      }

      actions(child, busy: busy)

      if steering {
        steerField(busy: busy)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(row.depth > 0 ? "\(child.goal), \(NativeStrings.Subagents.level(row.depth + 1))" : child.goal)
    .accessibilityIdentifier("hermie.agents.row.\(row.id)")
  }

  private func actions(_ child: Subagent, busy: Bool) -> some View {
    HStack(spacing: 16) {
      if row.canSteer {
        Button(Strings.Chat.Subagents.steer) { steering.toggle() }
          .accessibilityLabel(NativeStrings.Subagents.steerFor(child.goal))
          .accessibilityAddTraits(steering ? .isSelected : [])
          .accessibilityIdentifier("hermie.agents.steer.\(row.id)")
      }

      if row.isLive {
        Button(Strings.Chat.Subagents.stop, role: .destructive) {
          Task { await panel.stop(row.id) }
        }
        .disabled(busy)
        .accessibilityLabel(NativeStrings.Subagents.stopFor(child.goal))
        .accessibilityIdentifier("hermie.agents.stop.\(row.id)")
      }

      // A running child's transcript is its live tail; a finished one's is the session it left.
      if row.isLive || row.childSession != nil {
        Button(Strings.Chat.Subagents.openTranscript) {
          if row.isLive {
            panel.openTail(row.id, goal: child.goal)
          } else {
            openStored()
          }
        }
        .accessibilityLabel(NativeStrings.Subagents.transcriptFor(child.goal))
        .accessibilityIdentifier("hermie.agents.transcript.\(row.id)")
      }
    }
    .buttonStyle(.borderless)
    .font(.footnote)
  }

  private func steerField(busy: Bool) -> some View {
    HStack(spacing: 8) {
      TextField(Strings.Chat.Subagents.steerPlaceholder, text: $draft, axis: .vertical)
        .textFieldStyle(.roundedBorder)
        .lineLimit(1...4)
        .onSubmit { send() }
        .accessibilityIdentifier("hermie.agents.steerField.\(row.id)")

      Button(NativeStrings.Subagents.send) { send() }
        .buttonStyle(.borderedProminent)
        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("hermie.agents.steerSend.\(row.id)")
    }
  }

  /// What was typed goes back into the field when the gateway did not take it.
  private func send() {
    let words = draft

    Task {
      if await panel.steer(row.id, text: words) {
        draft = ""
        steering = false
      }
    }
  }

  private func tone(_ status: Subagent.Status) -> Color {
    switch status {
    case .running: .green
    case .failed: .red
    case .queued, .interrupted, .completed, .other: .secondary
    }
  }
}

/// One child's live tail, as a page of the sheet. It says it is a live tail: that tail stops existing
/// with the child, and a reader who cannot tell cannot tell whether "nothing new" means finished or lost.
struct SubagentTailPage: View {
  let tail: SubagentPanelModel.Tail

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        Text(Strings.Chat.Subagents.transcriptLive)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)

        if let error = tail.error {
          Text(verbatim: NativeStrings.Subagents.failed(error))
            .font(.callout)
            .foregroundStyle(.red)
        }

        if tail.loading, tail.text.isEmpty {
          ProgressView()
            .frame(maxWidth: .infinity)
        } else {
          Text(verbatim: tail.text.isEmpty || tail.unavailable ? Strings.Chat.Subagents.transcriptEmpty : tail.text)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(tail.text.isEmpty || tail.unavailable ? .secondary : .primary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("hermie.agents.tail.text")
        }
      }
      .padding()
    }
    .defaultScrollAnchor(.bottom)
    .accessibilityIdentifier("hermie.agents.tail")
  }
}
