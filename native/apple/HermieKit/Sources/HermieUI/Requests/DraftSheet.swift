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

  @ViewBuilder private var bodyText: some View {
    if params.isEditable {
      VStack(alignment: .leading, spacing: 8) {
        TextEditor(text: $draft.text)
          .font(.body.monospaced())
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
          .scrollContentBackground(.hidden)
          .frame(minHeight: 220)
          .padding(8)
          .background(.background.secondary, in: .rect(cornerRadius: 10))
          .accessibilityLabel(NativeStrings.Interactive.Draft.textLabel)
          .accessibilityIdentifier("draft.editor")

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

        let refused = draft.refusedCharacters

        if !refused.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            Label(NativeStrings.Interactive.Draft.hiddenWarning, systemImage: "eye.trianglebadge.exclamationmark")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(.red)
              .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: refused.map { "\($0.code) ×\($0.count)" }.joined(separator: "  "))
              .font(.footnote.monospaced())
              .fixedSize(horizontal: false, vertical: true)
            // The text as it would be sent, with those characters in view.
            Text(verbatim: DraftText.reveal(draft.text))
              .font(.footnote.monospaced())
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .textSelection(.enabled)
            Button(NativeStrings.Interactive.Draft.removeHidden) {
              draft.removeRefusedCharacters()
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("draft.removeHidden")
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("draft.hidden")
        }

        if draft.isTooLong {
          Label(NativeStrings.Interactive.Draft.tooLong(InteractivePrompt.draftLimit), systemImage: "exclamationmark.circle")
            .font(.footnote)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Text(verbatim: DraftText.reveal(draft.original))
          .font(.body.monospaced())
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
          .padding(12)
          .background(.background.secondary, in: .rect(cornerRadius: 10))
          .accessibilityLabel(NativeStrings.Interactive.Draft.textLabel)
          .accessibilityValue(DraftText.reveal(draft.original))
          .accessibilityIdentifier("draft.text")
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
