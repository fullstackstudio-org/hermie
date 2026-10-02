import HermieCore
import HermieGateway
import SwiftUI

/// One line about the gateway connection, over the chat list and the chat: connecting,
/// reconnecting, offline, signed out, too old. Nothing while it is ready or paused (the app is in
/// the background).
///
/// It waits a moment before it shows, so a reconnect that takes a second (every return from the
/// background) does not flash a banner. The chat's own `stale` hydration is not shown: it is the
/// same reconnect seen from the transcript.
struct ConnectionBanner: View {
  let status: ConnectionStatus
  var retry: (() -> Void)?
  var signIn: (() -> Void)?

  @State private var shown: ConnectionPhase?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  struct Content: Equatable {
    var text: String
    var symbol: String
    var canRetry: Bool
    var needsSignIn: Bool
  }

  static func content(for phase: ConnectionPhase) -> Content? {
    switch phase {
    case .ready, .paused:
      nil
    case .disconnected, .probing, .authenticating, .connecting:
      Content(text: Strings.App.Chat.Connection.connecting, symbol: "antenna.radiowaves.left.and.right", canRetry: false, needsSignIn: false)
    case .reconnecting:
      Content(text: Strings.App.Chat.Connection.reconnecting, symbol: "arrow.triangle.2.circlepath", canRetry: true, needsSignIn: false)
    case .offline:
      Content(text: Strings.App.Chat.Connection.offline, symbol: "wifi.slash", canRetry: true, needsSignIn: false)
    case .needsSignin:
      Content(text: Strings.App.Connection.Reauth.message, symbol: "person.badge.key", canRetry: false, needsSignIn: true)
    case .incompatible:
      Content(text: Strings.App.Errors.incompatible, symbol: "exclamationmark.triangle", canRetry: false, needsSignIn: false)
    }
  }

  var body: some View {
    ZStack {
      if let shown, let content = Self.content(for: shown) {
        banner(content)
          .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
      }
    }
    .animation(reduceMotion ? nil : .snappy, value: shown)
    .task(id: status.phase) {
      let phase = status.phase

      guard Self.content(for: phase) != nil else {
        shown = nil
        return
      }

      // Sign-in and an incompatible gateway are not going to fix themselves: say so at once.
      if phase != .needsSignin, phase != .incompatible {
        try? await Task.sleep(for: .milliseconds(900))
        guard !Task.isCancelled else { return }
      }

      shown = phase
    }
  }

  private func banner(_ content: Content) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: content.symbol)
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)

      Text(content.text)
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)

      if content.canRetry, let retry {
        Button(Strings.App.Chat.Connection.retry, action: retry)
          .buttonStyle(.borderless)
          .accessibilityIdentifier("hermie.connection.retry")
      }

      if content.needsSignIn, let signIn {
        Button(Strings.App.Connection.Reauth.action, action: signIn)
          .buttonStyle(.borderless)
          .accessibilityIdentifier("hermie.connection.signIn")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(.regularMaterial, in: .rect(cornerRadius: 12))
    .padding(.horizontal)
    .padding(.vertical, 6)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.connection.banner")
  }
}
