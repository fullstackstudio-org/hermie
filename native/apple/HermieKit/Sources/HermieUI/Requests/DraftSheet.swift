import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for a `review.draft`: the draft as the agent wrote it, with its subject and recipients
/// apart from the body, and the person's decision: Approve, Approve with changes, or Reject with an
/// optional comment.
///
/// The text is shown exactly as it is, in a monospaced block or editor, never as Markdown and never
/// with links. Characters that do not show as themselves (bidirectional controls, zero-width and
/// other format characters, control characters, unusual spaces) are shown as visible codes
/// (`DraftText.reveal`), so an approval cannot hide what it approves. When the draft is editable
/// the person edits it in place; text the gateway would refuse (`text:not_verbatim`) cannot be
/// approved, and the sheet says which characters and offers to remove them.
struct DraftSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let params: ReviewDraftParams

  @State private var draft: InteractiveDraftModel
  @State private var armed = false
  @State private var rejecting = false

  init(model: InteractiveModel, prompt: InteractivePrompt, params: ReviewDraftParams) {
    self.model = model
    self.prompt = prompt
    self.params = params
    _draft = State(initialValue: InteractiveDraftModel(params: params))
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "text.badge.checkmark",
      title: NativeStrings.Interactive.titleDraft(model.botName),
      busy: model.isSending
    ) {
      VStack(alignment: .leading, spacing: 16) {
        meta
        bodyText
        if rejecting {
          rejectionComment
        }
      }
      .disabled(model.isSending)
    } actions: {
      if rejecting {
        InteractiveButtonRow {
          Button {
            rejecting = false
          } label: {
            Text(NativeStrings.Interactive.Draft.back)
              .font(.title3.weight(.semibold))
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .tint(.primary)
          .controlSize(.large)
          .keyboardShortcut(.cancelAction)
          .disabled(model.isSending)
          .accessibilityIdentifier("draft.back")

          Button(role: .destructive) {
            reject()
          } label: {
            Text(model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.Draft.rejectConfirm)
              .font(.title3.weight(.semibold))
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .tint(.red)
          .controlSize(.large)
          .disabled(!armed || model.isSending || draft.commentIsTooLong)
          .accessibilityIdentifier("draft.rejectConfirm")
        }
      } else {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) {
            LaterButton(model: model)
            rejectButton
            approveButton
          }
          VStack(spacing: 10) {
            approveButton
            rejectButton
            LaterButton(model: model)
          }
        }
      }
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    .onDisappear {
      draft.wipe()
    }
  }

  // MARK: Pieces

  /// What kind of draft it is, its subject and its recipients: shown apart from the body, display
  /// only, with whatever does not show as itself made visible.
  @ViewBuilder private var meta: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(NativeStrings.Interactive.Draft.kind(params.kind))
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.background.secondary, in: .capsule)
        .accessibilityIdentifier("draft.kind")

      if let subject = params.subject, !subject.isEmpty {
        VStack(alignment: .leading, spacing: 2) {
          Text(NativeStrings.Interactive.Draft.subject)
            .font(.caption)
            .foregroundStyle(.secondary)
          Text(verbatim: DraftText.reveal(subject))
            .font(.body.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .accessibilityIdentifier("draft.subject")
        }
        .accessibilityElement(children: .combine)
      }

      if let recipients = params.recipients, !recipients.isEmpty {
        VStack(alignment: .leading, spacing: 2) {
          Text(NativeStrings.Interactive.Draft.recipients)
            .font(.caption)
            .foregroundStyle(.secondary)
          ForEach(Array(recipients.enumerated()), id: \.offset) { _, recipient in
            Text(verbatim: DraftText.reveal(recipient))
              .font(.callout.monospaced())
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("draft.recipients")
      }
    }
  }

  /// The draft's text. Never wrapped: a long line scrolls sideways, in the editor and in the
  /// read-only block alike, so no line break appears that the text does not have.
  @ViewBuilder private var bodyText: some View {
    if params.isEditable {
      VStack(alignment: .leading, spacing: 8) {
        NoWrapTextEditor(text: $draft.text)
          .frame(height: NoWrapTextEditor.minimumHeight)
          .background(.background.secondary, in: .rect(cornerRadius: 10))
          .accessibilityLabel(NativeStrings.Interactive.Draft.textLabel)
          .accessibilityHint(NativeStrings.Interactive.Draft.noWrapHint)

        if draft.isEdited {
          HStack {
            Label(NativeStrings.Interactive.Draft.edited, systemImage: "pencil")
              .font(.footnote)
              .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button(NativeStrings.Interactive.Draft.revert) {
              draft.revert()
            }
            .buttonStyle(.borderless)
            .font(.footnote)
            .accessibilityIdentifier("draft.revert")
          }
        }

        problemsView

        if draft.isTooLong {
          Label(NativeStrings.Interactive.Draft.tooLong(InteractivePrompt.draftLimit), systemImage: "exclamationmark.circle")
            .font(.footnote)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 8) {
        NoWrapText(text: DraftText.reveal(draft.original))
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(NativeStrings.Interactive.Draft.textLabel)
          .accessibilityValue(DraftText.reveal(draft.original))
        Text(NativeStrings.Interactive.Draft.notEditable)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }

    if !DraftText.hidden(in: draft.original).isEmpty || (params.subject.map { !DraftText.hidden(in: $0).isEmpty } ?? false) {
      Text(NativeStrings.Interactive.Draft.hiddenLegend)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// Which rules the text breaks, in words, the characters that break the first as visible codes,
  /// and a note that the person corrects it.
  @ViewBuilder private var problemsView: some View {
    let problems = draft.problems

    if !problems.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Label(NativeStrings.Interactive.Draft.hiddenWarning, systemImage: "eye.trianglebadge.exclamationmark")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)

        ForEach(Array(problems.enumerated()), id: \.offset) { _, problem in
          VStack(alignment: .leading, spacing: 4) {
            Text(Self.words(for: problem))
              .font(.footnote)
              .fixedSize(horizontal: false, vertical: true)

            if case .characters(let found) = problem {
              Text(verbatim: found.map { "\($0.code) ×\($0.count)" }.joined(separator: "  "))
                .font(.footnote.monospaced())
                .fixedSize(horizontal: false, vertical: true)
              // The text with those characters in view, as it would be sent.
              NoWrapText(text: DraftText.reveal(draft.text), compact: true, identifier: "draft.revealed")
            }
          }
        }

        // Nothing is rewritten for the person (contract §6.5): they correct the text, with the
        // characters and the lines in view.
        Text(NativeStrings.Interactive.Draft.correctNote)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("draft.problems")
    }
  }

  /// The rule a text breaks, in a sentence.
  static func words(for problem: DraftText.Problem) -> String {
    typealias Words = NativeStrings.Interactive.Draft

    switch problem {
    case .empty: return Words.problemEmpty
    case .characters: return Words.problemCharacters
    case .combiningMarks: return Words.problemMarks(DraftText.maxCombiningMarks)
    case .blankLines(let line): return Words.problemBlankLines(line, DraftText.maxBlankLines)
    case .lineTooLong(let line): return Words.problemLineTooLong(line, DraftText.maxLineChars)
    case .indent(let line): return Words.problemIndent(line, DraftText.maxIndent)
    case .spaceRun(let line): return Words.problemSpaceRun(line, DraftText.maxSpaceRun)
    }
  }

  private var rejectionComment: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(NativeStrings.Interactive.Draft.comment(model.botName))
        .font(.subheadline.weight(.semibold))
        .accessibilityHidden(true)
      TextField(NativeStrings.Interactive.Draft.comment(model.botName), text: $draft.comment, axis: .vertical)
        .lineLimit(2...6)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("draft.comment")
      if draft.commentIsTooLong {
        Text(NativeStrings.Interactive.Draft.commentTooLong(InteractivePrompt.commentLimit))
          .font(.footnote)
          .foregroundStyle(.red)
      }
    }
  }

  // MARK: Buttons

  private var approveButton: some View {
    Button {
      approve()
    } label: {
      Text(
        model.hasFailed
          ? NativeStrings.Interactive.tryAgain
          : (draft.isEdited ? NativeStrings.Interactive.Draft.approveWithChanges : NativeStrings.Interactive.Draft.approve))
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || model.isSending || !draft.canApprove)
    .accessibilityIdentifier(model.hasFailed ? "interactive.retry" : "draft.approve")
  }

  private var rejectButton: some View {
    Button {
      rejecting = true
    } label: {
      Text(NativeStrings.Interactive.Draft.reject)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .tint(.red)
    .controlSize(.large)
    .disabled(!armed || model.isSending)
    .accessibilityIdentifier("draft.reject")
  }

  private func approve() {
    guard armed, !model.isSending, draft.canApprove else {
      return
    }

    let answer = draft.approval

    Task {
      if await model.answer(answer) {
        draft.wipe()
      }
    }
  }

  private func reject() {
    guard armed, !model.isSending, !draft.commentIsTooLong else {
      return
    }

    let answer = draft.rejection

    Task {
      if await model.answer(answer) {
        draft.wipe()
      }
    }
  }
}
