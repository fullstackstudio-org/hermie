import HermieCore
import HermieTranscript
import SwiftUI

/// A bot asking to run a command. Open, it is a card with the command and one
/// button per choice the request carries; answered or withdrawn, it is a
/// one-line outcome. The buttons call `answerApproval`; nothing here talks to
/// the gateway.
struct ApprovalCardView: View {
  let item: ApprovalItem
  let presentation: Presentation

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.transcriptRequests) private var requests

  /// An answer to this card is on its way: its buttons are off meanwhile.
  private var sending: Bool { requests?.isSending(item.requestID) ?? false }

  var body: some View {
    if item.state == .open {
      openCard
    } else {
      ItemChip(text: outcome, systemImage: "checkmark.shield", tone: item.answer == "deny" ? .danger : .neutral)
        .accessibilityElement(children: .combine)
    }
  }

  private var openCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(Strings.Chat.Approval.title, systemImage: "lock.shield")
        .font(.headline)
        .accessibilityAddTraits(.isHeader)
      Text(item.command)
        .font(.callout.monospaced())
        .textSelection(.enabled)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: .rect(cornerRadius: 8))
      if let description = item.description, !description.isEmpty {
        Text(description)
          .font(.callout)
      }
      Text([Strings.Chat.Approval.runsOn, item.toolName].compactMap(\.self).joined(separator: " · "))
        .font(.caption)
        .foregroundStyle(.secondary)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { buttons }
        VStack(alignment: .leading, spacing: 8) { buttons }
      }
      .disabled(sending)
      if item.choices.contains("always") {
        Text(Strings.Chat.Approval.fine)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let requests {
        RequestStatusView(requests: requests, requestID: item.requestID)
      }
    }
    .cardSurface(tint: .orange)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Strings.Chat.Approval.title)
  }

  @ViewBuilder private var buttons: some View {
    ForEach(item.choices, id: \.self) { choice in
      let button = Button(role: choice == "deny" ? .destructive : nil) {
        actions.answerApproval(item, choice)
      } label: {
        Text(Self.label(for: choice))
          .lineLimit(1)
      }
      .accessibilityIdentifier("approval.\(choice)")
      if choice == item.choices.first && choice != "deny" {
        button.buttonStyle(.borderedProminent)
      } else {
        button.buttonStyle(.bordered)
      }
    }
  }

  private var outcome: String {
    if item.state == .cancelled {
      return item.cancelReason == "timeout" ? Strings.Chat.Approval.timedOut : Strings.Chat.Approval.answeredElsewhere
    }
    let answer = item.answer.map(Self.outcome(for:)) ?? Strings.Chat.Approval.answeredElsewhere
    let command = item.command.count > 48 ? String(item.command.prefix(48)) + "…" : item.command
    return "\(answer) · \(command)"
  }

  static func label(for choice: String) -> String {
    switch choice {
    case "once": Strings.Chat.Approval.Choices.once
    case "session": Strings.Chat.Approval.Choices.session
    case "always": Strings.Chat.Approval.Choices.always
    case "deny": Strings.Chat.Approval.Choices.deny
    default: ItemFormat.readableChoice(choice)
    }
  }

  static func outcome(for choice: String) -> String {
    switch choice {
    case "once": Strings.Chat.Approval.Outcomes.once
    case "session": Strings.Chat.Approval.Outcomes.session
    case "always": Strings.Chat.Approval.Outcomes.always
    case "deny": Strings.Chat.Approval.Outcomes.deny
    default: Strings.Chat.Approval.answered(choice: ItemFormat.readableChoice(choice))
    }
  }
}

/// A bot asking the reader something before it goes on: one question at a
/// time, with its options (one, or as many as apply) and a free-text answer.
/// Submitting calls `answerClarify` with every answer by question id.
///
/// The draft lives in the card while it is on screen; locked answers (the
/// server already took them) are shown, not edited.
struct ClarifyCardView: View {
  let item: ClarifyItem
  let presentation: Presentation

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.transcriptRequests) private var requests
  @State private var step = 0
  @State private var choices: [String: Set<String>] = [:]
  @State private var freeText: [String: String] = [:]
  @FocusState private var textFocused: Bool

  var body: some View {
    if item.state == .open, !item.questions.isEmpty {
      openCard
    } else {
      ItemChip(text: outcome, systemImage: "questionmark.bubble")
        .accessibilityElement(children: .combine)
    }
  }

  private var outcome: String {
    if item.state == .cancelled {
      return item.cancelReason == "timeout" ? Strings.Chat.Approval.timedOut : Strings.Chat.Approval.answeredElsewhere
    }
    let answered = item.questions.filter { item.answers[$0.qid] != nil }.count
    return Strings.Chat.Clarify.outcome(answered: answered, total: item.questions.count)
  }

  private var current: ClarifyQuestionItem {
    item.questions[min(step, item.questions.count - 1)]
  }

  private var isLast: Bool { step >= item.questions.count - 1 }

  /// An answer to this card is on its way.
  private var sending: Bool { requests?.isSending(item.requestID) ?? false }

  private var openCard: some View {
    let question = current
    let locked = item.locked.contains(question.qid)
    return VStack(alignment: .leading, spacing: 10) {
      Label(Strings.Chat.Clarify.title, systemImage: "questionmark.bubble")
        .font(.headline)
        .accessibilityAddTraits(.isHeader)
      if item.questions.count > 1 {
        Text(Strings.Chat.Clarify.step(current: step + 1, total: item.questions.count))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(question.question)
        .font(.body)
        .fixedSize(horizontal: false, vertical: true)
      if locked {
        Label(item.answers[question.qid] ?? "", systemImage: "lock.fill")
          .font(.callout)
        Text(Strings.Chat.Clarify.locked)
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        options(question)
        freeTextField(question)
      }
      HStack {
        if step > 0 {
          Button(Strings.Chat.Clarify.previous) { step -= 1 }
            .buttonStyle(.bordered)
        }
        Spacer()
        if isLast {
          Button(Strings.Chat.Clarify.submit, action: submit)
            .buttonStyle(.borderedProminent)
            .disabled(collectedAnswers().isEmpty || sending)
            .accessibilityIdentifier("clarify.submit")
        } else {
          Button(Strings.Chat.Clarify.next) { step += 1 }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("clarify.next")
        }
      }
      if let requests {
        RequestStatusView(requests: requests, requestID: item.requestID)
      }
    }
    .cardSurface(tint: .accentColor)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private func options(_ question: ClarifyQuestionItem) -> some View {
    if let options = question.choices, !options.isEmpty {
      if question.multiSelect {
        Text(Strings.Chat.Clarify.multiSelectHint)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      VStack(alignment: .leading, spacing: 6) {
        ForEach(options, id: \.self) { option in
          let selected = choices[question.qid, default: []].contains(option)
          Button {
            toggle(option, in: question)
          } label: {
            Label {
              Text(option)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
            } icon: {
              Image(systemName: Self.symbol(selected: selected, multi: question.multiSelect))
                .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .background(.fill.tertiary, in: .rect(cornerRadius: 10))
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(option)
          .accessibilityAddTraits(selected ? .isSelected : [])
          .accessibilityIdentifier("clarify.option.\(option)")
        }
      }
    }
  }

  private func freeTextField(_ question: ClarifyQuestionItem) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if question.choices?.isEmpty == false {
        Text(Strings.Chat.Clarify.freeText)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      TextField(
        Strings.Chat.Clarify.freeTextPlaceholder,
        text: Binding(
          get: { freeText[question.qid, default: ""] },
          set: { freeText[question.qid] = $0 }
        ),
        axis: .vertical
      )
      .textFieldStyle(.roundedBorder)
      .focused($textFocused)
      .onSubmit { isLast ? submit() : (step += 1) }
      .accessibilityIdentifier("clarify.freeText")
    }
  }

  private static func symbol(selected: Bool, multi: Bool) -> String {
    if multi { return selected ? "checkmark.square.fill" : "square" }
    return selected ? "largecircle.fill.circle" : "circle"
  }

  private func toggle(_ option: String, in question: ClarifyQuestionItem) {
    var set = choices[question.qid, default: []]
    if question.multiSelect {
      if set.contains(option) { set.remove(option) } else { set.insert(option) }
    } else {
      set = set.contains(option) ? [] : [option]
    }
    choices[question.qid] = set
  }

  /// qid → answer: free text wins over picked options; options keep the
  /// question's own order and join with ", ".
  private func collectedAnswers() -> [String: String] {
    var answers: [String: String] = [:]
    for question in item.questions {
      if let locked = item.answers[question.qid], item.locked.contains(question.qid) {
        answers[question.qid] = locked
        continue
      }
      let text = freeText[question.qid, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        answers[question.qid] = text
      } else if let picked = choices[question.qid], !picked.isEmpty {
        answers[question.qid] = (question.choices ?? []).filter(picked.contains).joined(separator: ", ")
      }
    }
    return answers
  }

  private func submit() {
    let answers = collectedAnswers()
    guard !answers.isEmpty, !sending else { return }
    actions.answerClarify(item, answers)
  }
}
