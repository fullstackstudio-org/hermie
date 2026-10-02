import HermieCore
import HermieTranscript
import SwiftUI

extension RequestsModel {
  /// The rows' actions, with the approval and clarify answers going through
  /// this model; everything else is `base`'s. Build it once per chat and hand
  /// it to `transcriptItemActions` (or use `answeringRequests(with:)`).
  public func transcriptItemActions(_ base: TranscriptItemActions = .none) -> TranscriptItemActions {
    var actions = base
    actions.answerApproval = { [self] item, choice in
      Task { await self.answerApproval(item.requestID, choice: choice) }
    }
    actions.answerClarify = { [self] item, answers in
      Task { await self.answerClarify(item.requestID, answers: answers) }
    }
    return actions
  }
}

extension EnvironmentValues {
  /// The chat's requests model, read by the approval and clarify cards for
  /// their in-flight, failed and countdown states. Nil outside a chat screen:
  /// the cards then show the question and their buttons only.
  @Entry public var transcriptRequests: RequestsModel?
}

extension View {
  /// Answer the chat's requests from its transcript rows and from a sheet: the
  /// rows' actions (`transcriptItemActions` built from `requests` over
  /// `base`), the cards' status, the sheet for a pending request, and the
  /// VoiceOver announcements.
  public func answeringRequests(
    with requests: RequestsModel,
    actions base: TranscriptItemActions = .none
  ) -> some View {
    modifier(RequestAnsweringModifier(requests: requests, base: base))
  }
}

struct RequestAnsweringModifier: ViewModifier {
  let requests: RequestsModel
  let base: TranscriptItemActions

  /// Built once: the rows compare on their items alone, so the closures must
  /// not change while the chat is open.
  @State private var actions: TranscriptItemActions?

  func body(content: Content) -> some View {
    content
      .environment(\.transcriptItemActions, actions ?? requests.transcriptItemActions(base))
      .environment(\.transcriptRequests, requests)
      .requestSheet(requests)
      .onAppear {
        if actions == nil {
          actions = requests.transcriptItemActions(base)
        }
      }
      .onChange(of: requests.lastAnswered) { _, answered in
        if answered != nil {
          AccessibilityNotification.Announcement(NativeStrings.Requests.answered).post()
        }
      }
      .onChange(of: requests.notice) { _, notice in
        if notice != nil {
          AccessibilityNotification.Announcement(NativeStrings.Requests.noLongerPending).post()
        }
      }
  }
}

/// Under a card or in a sheet: the answer on its way, the answer that did not
/// go out (with Retry), or the time left. Nothing when there is nothing to say.
struct RequestStatusView: View {
  let requests: RequestsModel
  let requestID: String

  var body: some View {
    switch requests.phase(of: requestID) {
    case .sending?:
      HStack(spacing: 6) {
        ProgressView()
          .controlSize(.small)
        Text(NativeStrings.Requests.sending)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("request.sending")
    case .failed(let reason)?:
      VStack(alignment: .leading, spacing: 6) {
        Label(NativeStrings.Requests.failed(reason), systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
        Button(NativeStrings.Requests.retry) {
          Task { await requests.retry(requestID) }
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("request.retry")
      }
      .accessibilityElement(children: .contain)
    case nil:
      if let deadline = requests.deadline(of: requestID) {
        RequestCountdownView(requests: requests, requestID: requestID, deadline: deadline)
      }
    }
  }
}

/// The time left before a request stops waiting, once a second; at zero the
/// card closes as a timeout.
struct RequestCountdownView: View {
  let requests: RequestsModel
  let requestID: String
  let deadline: Date

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let left = requests.secondsLeft(requestID, at: context.date) ?? 0
      Label(NativeStrings.Requests.closesIn(Self.clock(left)), systemImage: "timer")
        .font(.caption.monospacedDigit())
        .foregroundStyle(left <= 10 ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
        .accessibilityIdentifier("request.countdown")
    }
    .task(id: deadline) {
      let wait = deadline.timeIntervalSinceNow

      if wait > 0 {
        try? await Task.sleep(for: .seconds(wait))
      }

      guard !Task.isCancelled else {
        return
      }

      await requests.expire(requestID)
    }
  }

  /// `1:05`, `0:09`.
  static func clock(_ seconds: Int) -> String {
    Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond))
  }
}

/// The short line about a request that closed without the reader's answer,
/// for the chat screen to show near the composer. Nothing when there is none.
public struct RequestNoticeView: View {
  let requests: RequestsModel

  public init(requests: RequestsModel) {
    self.requests = requests
  }

  public var body: some View {
    if let entry = requests.notice {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(Self.text(entry.notice), systemImage: "info.circle")
          .font(.footnote)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Button {
          requests.dismissNotice()
        } label: {
          Image(systemName: "xmark")
            .accessibilityLabel(Strings.Chat.Sheet.close)
        }
        .buttonStyle(.borderless)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("request.notice")
    }
  }

  static func text(_ notice: RequestNotice) -> String {
    switch notice {
    case .noLongerPending: NativeStrings.Requests.noLongerPending
    }
  }
}

extension NativeStrings {
  enum Requests {
    /// Answer sent
    static var answered: String {
      String(localized: "native.requests.answered", table: "Native", bundle: .module)
    }
    /// Closes in {time}
    static func closesIn(_ time: String) -> String {
      String(localized: "native.requests.closesIn", defaultValue: "Closes in \(time)", table: "Native", bundle: .module)
    }
    /// Not sent: the connection dropped… (`ChatModel.unsentAnswerNotice`) / The answer was not sent: {reason}
    static func failed(_ reason: String?) -> String {
      guard let reason, !reason.isEmpty else {
        return String(localized: "native.requests.notSent", table: "Native", bundle: .module)
      }

      return String(
        localized: "native.requests.failed",
        defaultValue: "The answer was not sent: \(reason)",
        table: "Native",
        bundle: .module
      )
    }
    /// This question is no longer waiting for an answer.
    static var noLongerPending: String {
      String(localized: "native.requests.noLongerPending", table: "Native", bundle: .module)
    }
    /// Try again
    static var retry: String {
      String(localized: "native.requests.retry", table: "Native", bundle: .module)
    }
    /// Sending your answer…
    static var sending: String {
      String(localized: "native.requests.sending", table: "Native", bundle: .module)
    }
  }
}
