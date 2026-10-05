import Foundation
import Observation

public enum PermissionsPhase: Sendable, Equatable {
  case idle
  case loading
  case loaded
  case failed(PermissionFailure)
}

/// A revoke the page asks about before it goes out: one approval, or all of a scope's.
public struct PermissionRevocation: Sendable, Equatable, Identifiable {
  public var scope: PermissionScope
  /// The approval to take back; nil for "all of this scope's".
  public var grant: PermissionGrant?

  public init(scope: PermissionScope, grant: PermissionGrant?) {
    self.scope = scope
    self.grant = grant
  }

  public var id: String {
    switch (scope, grant) {
    case (.permanent, let grant?): "permanent:\(grant.id)"
    case (.permanent, nil): "permanent:*"
    case (.session(let session), let grant?): "session:\(session):\(grant.id)"
    case (.session(let session), nil): "session:\(session):*"
    }
  }
}

/**
 One bot's approvals on the gateway, for its Permissions page and its row on the bot settings: how the profile
 treats dangerous commands, the standing ("always") approvals, and the approvals of each live session; and what
 the page does to them, which is take them back.

 **A revoke is asked first.** The model has no public call that revokes: `ask(_:)` raises the question,
 `cancel()` drops it and only `confirm(_:)` sends anything. The page hands `confirm` the revocation its dialog
 presented, because the dialog's dismissal clears the question before its button's action runs.

 **The list follows the gateway.** After a revoke, whatever its answer, the revoked rows are taken off what is
 shown (the gateway removed them, or no longer has them) and the lists are read again. A revoke that did not
 answer in time may have gone through: nothing is taken off then, and the read says.

 **The decision log.** A revoke the gateway carried out (it answered that it removed something) is written to the
 decision log with the approval's label; a revoke that removed nothing, or that failed, is not.

 Every call names the bot (`profile`), so it reaches that bot's own approvals and nobody else's.
 */
@MainActor
@Observable
public final class PermissionsModel {
  /// The bot's name, which is its profile on the gateway.
  public let bot: String
  @ObservationIgnored let backend: any PermissionsBackend
  @ObservationIgnored let decisions: DecisionRecorder
  /// The ids the bot's own chat goes by (runtime and stored), to tell it from another live session of the profile.
  @ObservationIgnored let chatSessionIDs: @Sendable () async -> Set<String>

  public private(set) var phase: PermissionsPhase = .idle
  public private(set) var snapshot = PermissionsSnapshot()
  /// The ids the bot's own chat goes by, as of the last read.
  public private(set) var chatSessions: Set<String> = []

  /// The revocations on their way, by `PermissionRevocation.id`.
  public private(set) var revoking: Set<String> = []
  /// Why the last revoke did not go through.
  public private(set) var actionFailure: PermissionFailure?
  /// The revocation the page asks about before it is sent.
  public private(set) var pending: PermissionRevocation?

  @ObservationIgnored private var generation = 0

  public init(
    bot: String,
    backend: any PermissionsBackend,
    decisions: DecisionRecorder = .discarding(),
    chatSessionIDs: @escaping @Sendable () async -> Set<String> = { [] }
  ) {
    self.bot = bot
    self.backend = backend
    self.decisions = decisions
    self.chatSessionIDs = chatSessionIDs
  }

  // MARK: - What the page reads

  public var mode: ApprovalMode { snapshot.mode }
  public var permanent: [PermissionGrant] { snapshot.permanent }
  public var sessions: [SessionPermissions] { snapshot.sessions }

  /// How many approvals the bot has on the gateway (standing and sessions'); nil until a read said.
  public var count: Int? {
    phase == .loaded ? snapshot.count : nil
  }

  /// Whether a revoke of this is on its way.
  public func isRevoking(_ revocation: PermissionRevocation) -> Bool {
    revoking.contains(revocation.id)
  }

  /// Whether `session` is the bot's own chat.
  public func isChat(_ session: SessionPermissions) -> Bool {
    chatSessions.contains(session.sessionID) || (!session.sessionKey.isEmpty && chatSessions.contains(session.sessionKey))
  }

  // MARK: - Reading

  /// Read the lists. A failed read keeps what an earlier one found.
  public func load() async {
    generation += 1
    let mine = generation

    let hadRead = phase == .loaded

    if !hadRead {
      phase = .loading
    }

    let backend = self.backend
    let bot = self.bot
    let chatSessionIDs = self.chatSessionIDs

    async let listed = Result { try await backend.grants(profile: bot) }
    async let chatIDs = chatSessionIDs()
    let (read, chat) = await (listed, chatIDs)

    guard generation == mine else {
      return
    }

    switch read {
    case .success(let rows):
      snapshot = rows
      chatSessions = chat
      phase = .loaded
    case .failure(let error):
      phase = hadRead ? .loaded : .failed(.classify(error))
    }
  }

  // MARK: - Revoking

  /// Ask before `revocation` goes. Nothing is sent until `confirm(_:)`.
  public func ask(_ revocation: PermissionRevocation) {
    pending = revocation
  }

  /// The question went away without a yes.
  public func cancel() {
    pending = nil
  }

  public func dismissActionFailure() {
    actionFailure = nil
  }

  /// The person said yes to `revocation` (the one the dialog presented). Answers whether the gateway took
  /// something back.
  @discardableResult
  public func confirm(_ revocation: PermissionRevocation) async -> Bool {
    pending = nil

    guard !revoking.contains(revocation.id) else {
      return false
    }

    revoking.insert(revocation.id)
    defer { revoking.remove(revocation.id) }

    actionFailure = nil

    let labels = labels(of: revocation)
    let revoked: Int

    do {
      revoked = try await backend.revoke(
        profile: bot, scope: revocation.scope, target: revocation.grant.map { .one($0.id) } ?? .all)
    } catch {
      actionFailure = PermissionFailure.classify(error)
      await load()
      return false
    }

    if revoked > 0 {
      await decisions.permissionRevoked(bot: bot, session: Self.session(of: revocation.scope), label: labels)
    }

    forget(revocation)
    await load()
    return revoked > 0
  }

  /// What the decision log says was revoked: the approval's label, or the labels of every one an "all" took.
  private func labels(of revocation: PermissionRevocation) -> String {
    if let grant = revocation.grant {
      return grant.label
    }

    switch revocation.scope {
    case .permanent: return snapshot.permanent.map(\.label).joined(separator: "; ")
    case .session(let id):
      return snapshot.sessions.first { $0.sessionID == id }?.grants.map(\.label).joined(separator: "; ") ?? ""
    }
  }

  private static func session(of scope: PermissionScope) -> String {
    if case .session(let id) = scope { id } else { "" }
  }

  /// Take what the gateway answered it removed off what is shown, until the read after it says the same.
  private func forget(_ revocation: PermissionRevocation) {
    switch revocation.scope {
    case .permanent:
      snapshot.permanent.removeAll { revocation.grant == nil || $0.id == revocation.grant?.id }
    case .session(let id):
      guard let index = snapshot.sessions.firstIndex(where: { $0.sessionID == id }) else {
        return
      }

      snapshot.sessions[index].grants.removeAll { revocation.grant == nil || $0.id == revocation.grant?.id }
    }
  }
}
