import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// One out-of-band notice from the gateway (`notification.show`): a credits
/// line, "still starting the agent", and the like. Not part of any transcript.
public struct GatewayNotice: Sendable, Equatable, Identifiable {
  /// The notice's `key` (or its `id`): a second notice with the same one
  /// replaces it in place, and `notification.clear` names it.
  public var id: String
  /// Plain text, bounded (`GatewayNoticesModel.plainText`). Show it as text,
  /// never as markdown or a link: the gateway relays it from the agent.
  public var text: String
  public var level: NoticeLevel
  public var lifetime: NoticeLifetime
  /// The chat whose session it came on, when that session is bound to one. Most
  /// notices are about the account, whichever chat carried them.
  public var chat: String?
  /// When it goes on its own, on the model's clock; `nil` until a clear.
  public var expiresAfter: Duration?
}

/// The gateway's current notices, per session (`notification.show` /
/// `notification.clear`), for a banner or a status line.
///
/// Keyed by `key` (else `id`): a notice replaces the one with its key, a clear
/// withdraws it. A `ttl` notice, or any with a positive `ttl_ms`, expires on
/// the injected clock; `sticky` and `agent` stay until cleared or dismissed. At
/// most `maxNotices` are kept, oldest dropped first.
@MainActor
@Observable
public final class GatewayNoticesModel {
  public static let maxNotices = 8
  public static let maxTextLength = 400
  /// A `ttl` notice that names no lifetime of its own.
  public static let defaultLifetime: Duration = .seconds(8)

  /// Oldest first.
  public private(set) var notices: [GatewayNotice] = []

  @ObservationIgnored private let clock: any ConnectionClock
  @ObservationIgnored private var timers: [String: ScheduledTimer] = [:]
  /// Bumped on every show of an id, so a timer of a replaced notice does nothing.
  @ObservationIgnored private var revisions: [String: UInt64] = [:]
  @ObservationIgnored private var nextRevision: UInt64 = 0
  @ObservationIgnored private var unnamed = 0

  public init(clock: any ConnectionClock = SystemConnectionClock()) {
    self.clock = clock
  }

  /// The notice with this id, if it is still up.
  public func notice(_ id: String) -> GatewayNotice? {
    notices.first { $0.id == id }
  }

  /// The person closed it.
  public func dismiss(_ id: String) {
    remove(id)
  }

  /// Every notice goes (the session ended, the gateway changed).
  public func removeAll() {
    for timer in timers.values {
      timer.cancel()
    }

    timers.removeAll()
    revisions.removeAll()
    notices.removeAll()
  }

  // MARK: - From the gateway

  func show(_ payload: NotificationShowPayload, chat: String?) {
    let text = Self.plainText(payload.text ?? "")

    guard !text.isEmpty else {
      return
    }

    let id = Self.nonBlank(payload.key) ?? Self.nonBlank(payload.id) ?? nextUnnamed()
    let lifetime = payload.kind ?? .sticky
    let ttl = Self.lifetime(kind: lifetime, ttlMs: payload.ttlMs)
    let notice = GatewayNotice(
      id: id,
      text: text,
      level: payload.level ?? .info,
      lifetime: lifetime,
      chat: chat,
      expiresAfter: ttl
    )

    nextRevision += 1
    let revision = nextRevision
    revisions[id] = revision
    timers.removeValue(forKey: id)?.cancel()

    if let index = notices.firstIndex(where: { $0.id == id }) {
      notices[index] = notice
    } else {
      notices.append(notice)

      while notices.count > Self.maxNotices {
        remove(notices[0].id)
      }
    }

    if let ttl {
      timers[id] = clock.schedule(after: ttl) { [weak self] in
        await self?.expire(id, revision: revision)
      }
    }
  }

  func clear(key: String) {
    remove(key)
  }

  private func expire(_ id: String, revision: UInt64) {
    guard revisions[id] == revision else {
      return
    }

    remove(id)
  }

  private func remove(_ id: String) {
    timers.removeValue(forKey: id)?.cancel()
    revisions[id] = nil
    notices.removeAll { $0.id == id }
  }

  private func nextUnnamed() -> String {
    unnamed += 1
    return "notice-\(unnamed)"
  }

  private static func nonBlank(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }

    return value
  }

  /// `ttl_ms` when it is positive; the default for a `ttl` notice without one; otherwise none.
  static func lifetime(kind: NoticeLifetime, ttlMs: Int?) -> Duration? {
    if let ttlMs, ttlMs > 0 {
      return .milliseconds(ttlMs)
    }

    return kind == .ttl ? defaultLifetime : nil
  }

  /// The text as plain, bounded text: control characters and the bidirectional
  /// overrides and isolates (which can make a line read as something it is not)
  /// removed, tabs as spaces, line breaks kept, the ends trimmed, and at most
  /// `maxTextLength` characters.
  public static func plainText(_ raw: String) -> String {
    var scalars = String.UnicodeScalarView()

    for scalar in raw.replacingOccurrences(of: "\r\n", with: "\n").unicodeScalars {
      switch scalar.value {
      case 0x0A:
        scalars.append(scalar)
      case 0x09, 0x0D:
        scalars.append(" ")
      case 0x00...0x1F, 0x7F...0x9F, 0x202A...0x202E, 0x2066...0x2069:
        continue
      default:
        scalars.append(scalar)
      }
    }

    let text = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)

    guard text.count > maxTextLength else {
      return text
    }

    return String(text.prefix(maxTextLength - 1)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
  }
}
