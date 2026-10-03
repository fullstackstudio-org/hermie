import Foundation
import HermieCore
import HermieTranscript
import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/**
 What a chat screen knows about itself, as text the owner can paste into a report: the screen's
 appearances, its feed and the chat's state in the store, who holds the chat's model, the list's
 geometry, and the last lifecycle events of every chat screen (`ChatLifecycleLog`).

 A long press on the chat's title copies it (and so does the title's accessibility action), also
 when the screen draws nothing, which is the case it is for. It names bots, counts and states, and
 a failure only by its kind and status (`ChatResolver.category`): no message, draft, error text,
 address or credential is in it.
 */
@MainActor
enum ChatDiagnostics {
  static func report(
    chat: ChatRef,
    session: GatewaySession,
    screen: Int,
    owner: ChatFeedOwner<ChatFeed>,
    live: LiveGateway?
  ) -> String {
    var lines = ["Hermie chat diagnostics"]
    let build = BuildInfo.main
    lines.append("app \(build.version) (\(build.build), \(build.commit)) \(ProcessInfo.processInfo.operatingSystemVersionString)")
    lines.append("time \(Date().formatted(.iso8601))")
    lines.append("chat \(chat.bot) gateway \(chat.gatewayId.prefix(8)) live=\(live.map { phase($0.phase, kind: $0.failureKind) } ?? "none")")
    lines.append("connection \(session.status.phase)")

    if let row = session.chatList.rows[chat.bot] {
      lines.append("store hydration=\(row.hydration.rawValue) attached=\(row.attached) working=\(row.working)")
    } else {
      lines.append("store no row for this bot (roster rows \(session.chatList.rows.count))")
    }

    lines.append(
      "screen #\(screen) appearances=\(owner.appearances) disappearances=\(owner.disappearances) "
        + "offScreen=\(owner.offScreen)"
    )

    if let feed = owner.feed {
      let model = feed.model
      lines.append(
        "feed f\(feed.tag) stopped=\(feed.stopped) hydration=\(feed.hydration.rawValue) loaded=\(feed.loaded) "
          + "rows=\(feed.rows.count) items=\(model.items.count) revision=\(model.snapshot?.revision ?? -1) "
          + "activity=\(Self.activity(feed.activity)) older=\(feed.canLoadOlder)/\(feed.loadingOlder) "
          + "openError=\(kind(feed.openError, feed.openErrorKind))"
      )
      lines.append(
        "model canSend=\(model.canSend) turnActive=\(model.turnActive) lastError=\(kind(model.lastError, model.lastErrorKind))"
      )
      lines.append("lease \(feed.lease.id), holders \(ChatLeases.holders(session, chat.bot))")
      lines.append("read marks \(feed.readMarks) covered=\(feed.covered)")
      lines.append("list \(feed.listState.geometry?() ?? "no geometry") atBottom=\(feed.listState.isAtBottom)")
    } else {
      lines.append("feed none (the screen draws nothing), holders \(ChatLeases.holders(session, chat.bot))")
    }

    lines.append("events (seconds since the first), newest last:")
    lines.append(contentsOf: ChatLifecycleLog.events.suffix(40).map { "  " + $0 })

    return lines.joined(separator: "\n")
  }

  /// The live gateway's phase by name; a failure by its kind, never its message.
  static func phase(_ phase: LiveGatewayPhase, kind: String?) -> String {
    switch phase {
    case .none: "none"
    case .connecting: "connecting"
    case .live: "live"
    case .signedOut: "signedOut"
    case .failed: "failed(\(kind ?? "unknown"))"
    }
  }

  /// What the bot is doing, by name only (a tool's name stays out).
  private static func activity(_ activity: TurnActivity) -> String {
    switch activity {
    case .working: "working"
    case .thinking: "thinking"
    case .typing: "typing"
    case .tool: "tool"
    case .waiting: "waiting"
    case .delegating: "delegating"
    case .idle: "idle"
    }
  }

  /// "-" for no error, else its kind: the message itself can hold the gateway's address.
  private static func kind(_ message: String?, _ kind: String?) -> String {
    message == nil ? "-" : (kind ?? "unknown")
  }

  static func copy(_ text: String) {
    #if canImport(UIKit)
      UIPasteboard.general.string = text
    #elseif canImport(AppKit)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
    ChatLifecycleLog.note("diagnostics copied")
  }
}
