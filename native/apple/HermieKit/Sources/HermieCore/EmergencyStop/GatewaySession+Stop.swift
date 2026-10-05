import Foundation
import HermieGateway

/// The emergency stop's view of one live session.
@MainActor
public final class SessionStopGateway: StoppableGateway {
  public let gatewayId: String
  public let gatewayName: String
  private let session: GatewaySession

  public init(session: GatewaySession, name: String? = nil) {
    self.session = session
    self.gatewayId = session.gatewayID
    self.gatewayName = name ?? session.gatewayID
  }

  public func runningTurns() async -> RunningTurnReading? {
    guard session.status.phase == .ready else {
      return nil
    }

    let found = await session.store.runningSessions()
    var turns: [RunningTurn] = []

    for held in found.held {
      turns.append(RunningTurn(id: held.runtimeID, chatKey: held.key, botName: session.chatName(held.key)))
    }

    for other in found.other {
      turns.append(
        RunningTurn(
          id: other.runtimeID,
          botName: bot(forSessionKey: other.sessionKey).map { session.chatName($0) } ?? "",
          title: SecurePrompt.displayText(other.title, limit: 60)
        ))
    }

    return RunningTurnReading(turns: turns, unreachable: found.unreachable, complete: found.listed)
  }

  public func stop(_ turn: RunningTurn) async -> StopOutcome {
    guard session.status.phase == .ready else {
      return .notConnected
    }

    do {
      let interrupted: Bool

      if let key = turn.chatKey {
        interrupted = try await session.store.interruptTurn(key)
      } else {
        interrupted = try await session.store.interruptSession(turn.id)
      }

      return interrupted ? .stopped : .alreadyDone
    } catch {
      return .failed(ChatResolver.describe(error))
    }
  }

  /// The bot whose own chat the gateway lists under `key` (its stored or resolved id), if the roster
  /// knows one.
  private func bot(forSessionKey key: String) -> String? {
    guard !key.isEmpty else {
      return nil
    }

    return session.chatList.rows.values.first {
      $0.bot.canonical?.id == key || $0.bot.canonical?.resolvedID == key
    }?.bot.name
  }
}
