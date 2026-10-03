import HermieCore
import HermieTranscript
import SwiftUI

extension View {
  /// The sheet for a pending request: raised for the oldest open question the
  /// reader has not put away, and for one `RequestsModel.present(_:)` names.
  /// Putting it away (Later, Esc, a swipe down) is never an answer.
  public func requestSheet(_ requests: RequestsModel) -> some View {
    modifier(RequestSheetModifier(requests: requests))
  }
}

struct RequestSheetModifier: ViewModifier {
  let requests: RequestsModel

  private struct Presented: Identifiable {
    let id: String
  }

  func body(content: Content) -> some View {
    content
      .sheet(item: presented) { presented in
        RequestSheetView(requests: requests, requestID: presented.id)
          .presentationDetents([.large])
          // Opaque at every detent: a command to approve is read against a
          // plain background, never against the transcript showing through.
          .presentationBackground(.background)
          // A passkey confirmation is answered by Confirm or Decline, or it ends: Esc and a swipe
          // never close it while it is open.
          .interactiveDismissDisabled(requests.presentedConfirmation?.isOpen == true)
          #if os(macOS)
            .frame(minWidth: 420, idealWidth: 480, minHeight: 320)
          #endif
      }
      .onChange(of: requests.nextToPresent, initial: true) { _, next in
        if requests.presentedRequestID == nil, let next {
          requests.present(next)
        }
      }
      .task(id: requests.unroutedConfirmationIDs) {
        await routeConfirmations()
      }
  }

  /// A confirmation belongs to the chat that holds its session. One whose session is not bound yet
  /// is asked about again: a reconnect re-delivers open requests before the resume that binds them.
  private func routeConfirmations() async {
    for _ in 0..<120 {
      if await requests.routeConfirmations() {
        return
      }

      try? await Task.sleep(for: .milliseconds(500))

      if Task.isCancelled {
        return
      }
    }
  }

  private var presented: Binding<Presented?> {
    Binding(
      get: { requests.presentedRequestID.map(Presented.init(id:)) },
      set: { value in
        if value == nil, requests.presentedRequestID != nil {
          requests.dismissSheet()
        }
      }
    )
  }
}

/// One request, in a sheet: the approval with exactly the choices the gateway
/// offered, or the clarify with its options and free text. Once the question
/// is no longer open, its outcome and a Close button.
struct RequestSheetView: View {
  let requests: RequestsModel
  let requestID: String

  var body: some View {
    if let confirmation = requests.presentedConfirmation, let passkeys = requests.passkeys {
      ConfirmSheetView(requests: requests, passkeys: passkeys, confirmation: confirmation)
        // A view of its own per confirmation: how far its detail was read, and the tap guard, never
        // carry over to the next one.
        .id(confirmation.id)
    } else {
      approvalsBody
    }
  }

  private var approvalsBody: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        switch requests.presentedRequest {
        case .approval(let item)?:
          ApprovalSheetContent(requests: requests, item: item)
        case .clarify(let item)?:
          ClarifySheetContent(requests: requests, item: item)
        default:
          EmptyView()
        }

        // Later while the question is open (it stays open, in the transcript),
        // Close once it is not. Esc does the same.
        Button {
          requests.dismissSheet()
        } label: {
          Text(isOpen ? Strings.Chat.Clarify.later : Strings.Chat.Sheet.close)
            .font(.title3.weight(.semibold))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(.primary)
        .controlSize(.large)
        .keyboardShortcut(.cancelAction)
        .accessibilityIdentifier("request.sheet.dismiss")
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .environment(\.transcriptRequests, requests)
    .environment(\.transcriptItemActions, requests.transcriptItemActions())
    .accessibilityIdentifier("request.sheet")
  }

  private var isOpen: Bool {
    switch requests.presentedRequest {
    case .approval(let item)?: item.state == .open
    case .clarify(let item)?: item.state == .open
    default: false
    }
  }
}

/// How a request that is no longer open ended, in one line.
func requestOutcome(state: RequestState, cancelReason: String?, answered: String) -> String {
  switch state {
  case .answered: answered
  case .cancelled where cancelReason == "timeout": Strings.Chat.Approval.timedOut
  default: Strings.Chat.Approval.answeredElsewhere
  }
}

/// The approval sheet (ADR-0010): eyebrow, title, the lead line, the command,
/// what it is for, and one button per choice the request carries, in its
/// order. Taps are accepted 400 ms after the question appears, so a sheet that
/// comes up under a moving finger cannot answer a question nobody read.
struct ApprovalSheetContent: View {
  let requests: RequestsModel
  let item: ApprovalItem

  /// How long after the question appears its buttons stay off.
  static let tapGuard: Duration = .milliseconds(400)

  @State private var armed = false

  var body: some View {
    Text(Strings.Chat.Approval.eyebrow(handle: requests.bot))
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
    Text(Strings.Chat.Approval.title)
      .font(.title2.bold())
      .accessibilityAddTraits(.isHeader)
    Text(Strings.Chat.Approval.lead(handle: requests.bot))
      .foregroundStyle(.secondary)
    Text(item.command)
      .font(.body.monospaced())
      .textSelection(.enabled)
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background.secondary, in: .rect(cornerRadius: 10))
      .accessibilityIdentifier("request.sheet.command")
    if let description = item.description, !description.isEmpty {
      Text(description)
        .foregroundStyle(.secondary)
    }
    if let tool = item.toolName {
      Text("\(Strings.Chat.Approval.runsOn) · \(tool)")
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    if item.state == .open {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(item.choices, id: \.self) { choice in
          choiceButton(choice)
        }
      }
      .disabled(!armed || requests.isSending(item.requestID))
      .task(id: item.requestID) {
        armed = false
        try? await Task.sleep(for: Self.tapGuard)
        armed = true
      }
      if item.choices.contains("always") {
        Text(Strings.Chat.Approval.fine)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      RequestStatusView(requests: requests, requestID: item.requestID)
    } else {
      outcome
    }
  }

  @ViewBuilder private func choiceButton(_ choice: String) -> some View {
    let button = Button(role: choice == "deny" ? .destructive : nil) {
      Task { await requests.answerApproval(item.requestID, choice: choice) }
    } label: {
      // Large, bold text: legible on the tinted fills, Deny's red included.
      Text(ApprovalCardView.label(for: choice))
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .controlSize(.large)
    .accessibilityIdentifier("request.sheet.\(choice)")

    // Allow once and Deny filled (white on the tint reads; tinted text on a
    // tinted fill does not), the others plain.
    switch choice {
    case "once": button.buttonStyle(.borderedProminent)
    case "deny": button.buttonStyle(.borderedProminent).tint(.red)
    default: button.buttonStyle(.bordered).tint(.primary)
    }
  }

  @ViewBuilder private var outcome: some View {
    let answered = Strings.Chat.Approval.answered(choice: ApprovalCardView.label(for: item.answer ?? ""))
    Text(requestOutcome(state: item.state, cancelReason: item.cancelReason, answered: answered))
      .font(.headline)
      .accessibilityIdentifier("request.sheet.outcome")
    if requests.notice?.requestID == item.requestID {
      RequestNoticeView(requests: requests)
    }
  }
}

/// The clarify sheet: the same stepper as the inline card (options and free
/// text together, locked answers shown, not edited), under the sheet's title.
struct ClarifySheetContent: View {
  let requests: RequestsModel
  let item: ClarifyItem

  var body: some View {
    Text(Strings.Chat.Clarify.eyebrow)
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
    if item.state == .open {
      ClarifyCardView(item: item, presentation: .full)
        .id(item.requestID)
    } else {
      Text(Strings.Chat.Clarify.title)
        .font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
      let answered = item.questions.filter { item.answers[$0.qid] != nil }.count
      Text(
        requestOutcome(
          state: item.state,
          cancelReason: item.cancelReason,
          answered: Strings.Chat.Clarify.outcome(answered: answered, total: item.questions.count)
        )
      )
      .font(.headline)
      .accessibilityIdentifier("request.sheet.outcome")
    }
  }
}
