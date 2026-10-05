import Foundation
import HermieGateway
import HermieProtocol

/// The emergency stop's view of one live session.
@MainActor
public final class SessionStopGateway: StoppableGateway {
  public let gatewayId: String
  public let gatewayName: String
  private let session: GatewaySession
  /// The gateway answered `-32601` to `session.interrupt_all`.
  private var isWithoutStopEverything = false

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

  /// Stops everything of the caller's in one call, where the gateway has `session.interrupt_all`. A gateway
  /// that answers `-32601` is remembered as one that has not, so the next stop does not ask again.
  public func stopEverything() async -> StopEverythingOutcome {
    guard session.status.phase == .ready else {
      return .notConnected
    }

    guard !isWithoutStopEverything else {
      return .unsupported
    }

    do {
      guard let answer = InterruptAllResult.parse(try await session.store.interruptEverything()) else {
        return .failed("")
      }

      return .answered(report(of: answer))
    } catch let error as GatewayRPCError {
      switch error.kind {
      case .rejected where error.code == -32601:
        isWithoutStopEverything = true
        return .unsupported
      case .notConnected, .closed:
        return .notConnected
      default:
        return .failed(ChatResolver.describe(error))
      }
    } catch {
      return .failed(ChatResolver.describe(error))
    }
  }

  /// The one-call answer, with each turn named by the bot of its profile as the person knows it.
  private func report(of answer: InterruptAllResult) -> StopEverythingReport {
    StopEverythingReport(
      stopped: answer.stopped.map { entry in
        RunningTurn(
          id: entry.sessionID,
          botName: entry.profile.isEmpty ? "" : session.chatName(entry.profile),
          title: entry.title,
          source: entry.source
        )
      },
      alreadyIdle: answer.alreadyIdle, notAllowed: answer.notAllowed, failed: answer.failed)
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
