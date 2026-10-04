import HermieCore
import SwiftUI

/// A request of a chat the person put away (Later, Esc, or leaving the chat while it was up) and that
/// is still open: by its id and the model it belongs to.
struct WaitingRequest: Equatable, Hashable, Sendable {
  let id: String
  let kind: RequestShelf.Kind
}

/// Over the chat, while a request that was put away still waits: one line that says so and opens
/// the oldest one again. A request put away is never raised by itself again, so this is how the person
/// finds it (an approval and a question also wait as cards in the transcript, a form as its card; a
/// secure prompt and a passkey confirmation have only this). Nothing while a request has the screen.
struct WaitingRequestsBanner: View {
  let feed: ChatFeed

  var body: some View {
    let waiting = feed.waitingRequests

    if let first = waiting.first, !feed.requestUp {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Label(NativeStrings.Requests.waiting(waiting.count), systemImage: "hourglass")
          .font(.callout)
          .frame(maxWidth: .infinity, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)
        Button(NativeStrings.Requests.openWaiting) {
          feed.open(first)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .accessibilityIdentifier("chat.waitingRequests.open")
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(.regularMaterial, in: .rect(cornerRadius: 12))
      .padding(.horizontal, ChatSpacing.edgeMargin)
      .padding(.vertical, 6)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat.waitingRequests")
    }
  }
}

extension NativeStrings.Requests {
  /// A request is waiting for your answer. / {count} requests are waiting for your answer.
  static func waiting(_ count: Int) -> String {
    if count == 1 {
      return String(localized: "native.requests.waiting.one", table: "Native", bundle: .module)
    }

    return String(
      localized: "native.requests.waiting.other", defaultValue: "\(count) requests are waiting for your answer.",
      table: "Native", bundle: .module)
  }

  /// Open
  static var openWaiting: String {
    String(localized: "native.requests.waiting.open", table: "Native", bundle: .module)
  }
}
