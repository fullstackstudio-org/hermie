import HermieCore
import HermieProtocol
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// The gateway's own notices (`notification.show`), as plain dismissible lines. The chat list shows
/// the ones about the account (`chat == nil`); a chat adds its own.
struct GatewayNoticesView: View {
  let model: GatewayNoticesModel
  /// The chat whose notices are shown too, or nil for the account's alone.
  let chat: String?

  var body: some View {
    let shown = model.notices.filter { $0.chat == nil || $0.chat == chat }

    if !shown.isEmpty {
      VStack(spacing: 6) {
        ForEach(shown) { notice in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: Self.symbol(notice.level))
              .foregroundStyle(Self.tint(notice.level))
              .accessibilityHidden(true)
            // Relayed from the agent: drawn as text, never as Markdown or a link.
            Text(verbatim: notice.text)
              .font(.callout)
              .frame(maxWidth: .infinity, alignment: .leading)
              .fixedSize(horizontal: false, vertical: true)
            Button(Strings.App.Common.dismiss, systemImage: "xmark") {
              model.dismiss(notice.id)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
          }
          .padding(.leading, 12)
          .background(.regularMaterial, in: .rect(cornerRadius: 12))
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("hermie.gatewayNotice")
        }
      }
      .padding(.horizontal)
      .padding(.vertical, 4)
    }
  }

  static func symbol(_ level: NoticeLevel) -> String {
    switch level {
    case .error: "exclamationmark.octagon"
    case .warn: "exclamationmark.triangle"
    case .success: "checkmark.circle"
    default: "info.circle"
    }
  }

  static func tint(_ level: NoticeLevel) -> Color {
    switch level {
    case .error: .red
    case .warn: .orange
    case .success: .green
    default: .secondary
    }
  }
}

/// A bot waiting for the reader to connect an account (`connection.request`): one row per account
/// with its host, Open (the authorisation page, in the browser) and Skip, and Cancel for the whole
/// request. The answer goes through `ConnectionRequestsModel`; the card moves when the gateway
/// reports back.
struct ConnectionRequestCard: View {
  let model: ConnectionRequestsModel
  let chat: String

  @Environment(\.openURL) private var openURL

  var body: some View {
    if let request = model.request(for: chat) {
      VStack(alignment: .leading, spacing: 10) {
        Label(NativeStrings.ConnectionRequest.title, systemImage: "link.badge.plus")
          .font(.headline)
          .accessibilityAddTraits(.isHeader)

        ForEach(request.targets) { target in
          VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: target.name)
              .font(.body.weight(.semibold))
            if let link = target.link {
              Text(verbatim: link.host)
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if !target.detail.isEmpty {
              Text(verbatim: target.detail)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            }
            if target.state == .pending || target.state == .initiated || target.state == .notConnected {
              HStack(spacing: 8) {
                if let link = target.link {
                  Button(NativeStrings.ConnectionRequest.open) {
                    openURL(link.url)
                    model.markOpened(chat: chat, target: target.name)
                  }
                  .buttonStyle(.borderedProminent)
                  .accessibilityIdentifier("hermie.connection.open")
                }
                Button(NativeStrings.ConnectionRequest.skip) {
                  Task { await model.skip(chat: chat, target: target.name) }
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("hermie.connection.skip")
              }
            }
          }
        }

        Button(Strings.App.Common.cancel, role: .cancel) {
          Task { await model.cancel(chat: chat) }
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("hermie.connection.cancel")
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.regularMaterial, in: .rect(cornerRadius: 12))
      .padding(.horizontal)
      .padding(.vertical, 4)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("hermie.connectionRequest")
    }
  }
}

/// One line where the account is shown: this client is anonymous on the gateway (a session token,
/// or no account), so its messages carry no name.
struct AnonymousIdentityLine: View {
  let session: GatewaySession

  var body: some View {
    if case .anonymous = session.identityState {
      Label(NativeStrings.Identity.anonymous, systemImage: "person.crop.circle.badge.questionmark")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("hermie.identity.anonymous")
    }
  }
}
