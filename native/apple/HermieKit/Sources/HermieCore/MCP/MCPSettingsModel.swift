import Foundation
import HermieGateway
import HermieProtocol
import Observation

/**
 One gateway's MCP endpoint, as Settings › MCP shows it (plan `gateway-mcp.md` N1, contract
 `contract/gateway/mcp.md`): whether the gateway offers it, the address, the command and the
 configuration to copy, the gateway's own instructions, and the MCP clients the person has allowed,
 each with a way to revoke it.

 Hermie never speaks MCP and runs no server: this model reads what the gateway says
 (`GET /api/auth/mcp`), ends a grant (`POST /api/auth/mcp/grants/{id}/revoke`) and reloads when
 something changed (`mcp.changed`), and that is all.

 What it never does:

 - run, build or rewrite what the gateway sent: the command, the configuration and the endpoint are
   kept exactly as received, and the page copies them as received;
 - log a client's name, an address or a user agent;
 - ask for a confirmation itself: the page does, then calls `revoke(grantID:)`.

 Where the gateway answers that it has no MCP (404) or no person to answer for (403), nothing else
 is shown: `settings` is cleared with the phase.
 */
@MainActor
@Observable
public final class MCPSettingsModel {
  /// Where the read stands. The page says exactly one thing about it.
  public enum Phase: Sendable, Equatable {
    /// The first read has not answered.
    case loading
    /// The gateway answered; `settings` holds it.
    case ready
    /// The gateway has no MCP endpoint, or it is switched off.
    case notOffered
    /// Signed in without a person (a session-token or ungated gateway).
    case noIdentity
    /// This device is not signed in to the gateway.
    case signedOut
    /// The last read failed for another reason (no connection, a refusal, an answer that is not the
    /// route's). `settings` is what was read before, if anything.
    case unreadable
  }

  /// One thing that changed without this page asking, from `mcp.changed`.
  public struct Notice: Sendable, Equatable, Identifiable {
    public let id: UInt64
    public let change: MCPChange
    /// The client's name, one bounded line (`displayName`); empty when the frame named none.
    public let clientName: String
    public let at: Double

    public init(id: UInt64, change: MCPChange, clientName: String, at: Double) {
      self.id = id
      self.change = change
      self.clientName = clientName
      self.at = at
    }
  }

  /// The last `GET /api/auth/mcp`, `nil` until one answered and again after a 404 or a 403.
  public internal(set) var settings: MCPSettings?
  public internal(set) var phase: Phase = .loading
  /// The grants being revoked now, by id.
  public internal(set) var revoking: Set<String> = []
  /// The last revoke did not end its grant (the gateway could not be reached, or refused): try again.
  public internal(set) var revokeFailed = false
  /// The newest change another session or the operator made, until it is dismissed.
  public internal(set) var notice: Notice?

  @ObservationIgnored let link: (any GatewayLink)?
  @ObservationIgnored let client: (any MCPRouting)?
  @ObservationIgnored let now: @Sendable () -> Double
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var started = false
  @ObservationIgnored var isShutDown = false
  /// The read in flight, and whether another was asked for while it ran.
  @ObservationIgnored private var reading: Task<Void, Never>?
  @ObservationIgnored private var rereadRequested = false
  /// Grant ids this device is revoking: their `mcp.changed` is no news.
  @ObservationIgnored var expectedRevocations: Set<String> = []
  @ObservationIgnored private var nextNoticeID: UInt64 = 0

  /// The longest client name shown, in characters.
  public nonisolated static let nameLimit = 80
  /// The longest address shown, in characters.
  public nonisolated static let addressLimit = 64

  /// - Parameters:
  ///   - link: the connection whose events carry `mcp.changed`; `nil` for a model that is only read
  ///     and written (a test of the routes).
  ///   - client: the two routes; `nil` for a link without a REST side, which reads as unreadable.
  public init(
    link: (any GatewayLink)?,
    client: (any MCPRouting)?,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) {
    self.link = link
    self.client = client
    self.now = now
  }

  // MARK: - Lifecycle

  /// Subscribe to the link's events. Call before the link starts, as the session does, so no
  /// `mcp.changed` is missed; the first read is the page's (`refresh()` when it opens).
  public func start() {
    guard !started, !isShutDown, let link else {
      return
    }

    started = true
    let events = link.events

    // Off the main actor: the stream carries every token of every reply, and one type is ours.
    tasks.append(
      Task.detached { [weak self] in
        for await wire in events where wire.event.type == MCPChangedPayload.eventType {
          await self?.receive(wire.event)
        }
      }
    )
  }

  /// Stop listening.
  public func shutdown() {
    guard !isShutDown else {
      return
    }

    isShutDown = true

    for task in tasks {
      task.cancel()
    }

    tasks.removeAll()
    reading?.cancel()
  }

  // MARK: - Reading

  /// Read `GET /api/auth/mcp` again. A read asked for while another runs is made once more after
  /// it, so the last word is always a read that began after the last request. Never throws: `phase`
  /// says what came back, and a failed read keeps what was shown before.
  public func refresh() async {
    guard client != nil, !isShutDown else {
      if client == nil, settings == nil {
        phase = .unreadable
      }

      return
    }

    if let reading {
      rereadRequested = true
      await reading.value
      return
    }

    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      repeat {
        rereadRequested = false
        await readOnce()
      } while rereadRequested && !isShutDown
      reading = nil
    }

    reading = task
    await task.value
  }

  private func readOnce() async {
    guard let client else {
      return
    }

    do {
      settings = try await client.settings()
      phase = .ready
    } catch let error as MCPRouteError {
      adopt(error)
    } catch {
      // A cancellation: the page went away, and what it showed stays.
    }
  }

  /// What a refusal means for the page.
  private func adopt(_ error: MCPRouteError) {
    switch error.kind {
    case .notOffered:
      settings = nil
      phase = .notOffered
    case .noIdentity:
      settings = nil
      phase = .noIdentity
    case .signedOut:
      settings = nil
      phase = .signedOut
    case .notFound, .originNotListed, .unreachable, .refused, .unexpectedAnswer:
      phase = .unreadable
    }
  }

  // MARK: - Revoking

  /// End one grant. Returns whether it is gone: the gateway said so, or said there is no such grant
  /// (which is the same to the person, and never an error). The grant leaves the list at once and
  /// the list is read again, so what the gateway says last is what stays.
  @discardableResult
  public func revoke(grantID: String) async -> Bool {
    guard let client, !isShutDown, !revoking.contains(grantID) else {
      return false
    }

    revoking.insert(grantID)
    expectedRevocations.insert(grantID)
    revokeFailed = false
    defer { revoking.remove(grantID) }

    do {
      try await client.revoke(grantID: grantID)
    } catch let error as MCPRouteError {
      guard error.kind == .notFound else {
        expectedRevocations.remove(grantID)
        adoptRevokeFailure(error)
        return false
      }
    } catch {
      expectedRevocations.remove(grantID)
      return false
    }

    remove(grantID)
    await refresh()
    return true
  }

  private func adoptRevokeFailure(_ error: MCPRouteError) {
    switch error.kind {
    case .notOffered, .noIdentity, .signedOut:
      // The same answers a read gets: the page shows that instead of a list.
      adopt(error)
    default:
      revokeFailed = true
    }
  }

  private func remove(_ grantID: String) {
    guard var next = settings else {
      return
    }

    next.grants = (next.grants ?? []).filter { $0.id != grantID }
    settings = next
  }

  /// The person closed the failure line.
  public func dismissRevokeFailure() {
    revokeFailed = false
  }

  // MARK: - Events

  private func receive(_ event: GatewayEvent) async {
    let payload = MCPChangedPayload(json: event.payload?.objectValue ?? [:])
    let id = payload.grant?.id ?? ""
    let ours = payload.change == .revoked && expectedRevocations.remove(id) != nil

    if !ours {
      nextNoticeID += 1
      notice = Notice(
        id: nextNoticeID,
        change: payload.change ?? .unknown(""),
        clientName: Self.displayName(payload.grant?.clientName),
        at: payload.at ?? now()
      )
    }

    // A hint to reload, not the state.
    await refresh()
  }

  /// The person closed the notice.
  public func dismissNotice() {
    notice = nil
  }

  // MARK: - Untrusted text

  /// A client's name, which it chose: one line, no control or direction characters, bounded
  /// (`SecurePrompt.displayText`).
  public nonisolated static func displayName(_ raw: String?) -> String {
    SecurePrompt.displayText(raw, limit: nameLimit).replacingOccurrences(of: "\n", with: " ")
  }

  /// An address (or a user agent) from a grant, shown on one bounded line; empty when there is none.
  public nonisolated static func displayAddress(_ raw: String?) -> String {
    SecurePrompt.displayText(raw, limit: addressLimit).replacingOccurrences(of: "\n", with: " ")
  }

  /// The gateway's own prose, kept readable and bounded: line breaks stay, nothing that draws
  /// nothing or reorders text does.
  public nonisolated static func displayProse(_ raw: String?) -> String {
    SecurePrompt.displayText(raw, limit: SecurePrompt.textLimit * 4)
  }
}
