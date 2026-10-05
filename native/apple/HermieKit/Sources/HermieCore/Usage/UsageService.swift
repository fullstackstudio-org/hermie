import Foundation
import HermieGateway
import HermieProtocol

/// Why a usage read did not answer, sorted by what the screen should do about it.
public enum UsageFailure: Error, Sendable, Equatable {
  /// The gateway has no such route or method (an older gateway, or one with the dashboard routes
  /// switched off). The section says usage is not available there, not that something broke.
  case unsupported
  /// No connection to ask over, or none in time. Try again.
  case offline
  /// The gateway said no, or sent nothing usable, in its own words (untrusted text).
  case failed(String)

  /// The gateway's own words, when it had some.
  public var detail: String? {
    if case .failed(let message) = self, !message.isEmpty { message } else { nil }
  }

  /// Sort anything a gateway call can throw.
  public static func classify(_ error: any Error) -> UsageFailure {
    if let failure = error as? UsageFailure {
      return failure
    }

    if let rpc = error as? GatewayRPCError {
      switch rpc.kind {
      case .notConnected, .closed, .timeout: return .offline
      case .rejected: return rpc.code == -32601 ? .unsupported : .failed(CapabilityText.line(rpc.message))
      case .unencodable, .unexpectedResult: return .failed(CapabilityText.line(rpc.message))
      }
    }

    if let gateway = error as? GatewayError {
      switch gateway.kind {
      case .network, .timeout, .tls: return .offline
      default:
        if gateway.status == 404 || gateway.status == 405 {
          return .unsupported
        }

        return .failed(CapabilityText.words(of: gateway))
      }
    }

    if error is CancellationError {
      return .offline
    }

    return .failed(CapabilityText.words(of: error))
  }
}

/// What the usage screens ask of the gateway, as one seam: a test hands in a script, production a
/// `UsageService` over a session's link.
public protocol UsageBackend: Sendable {
  /// A profile's days over the last `days` days (`GET /api/analytics/usage`), oldest first.
  func daily(profile: String, days: Int) async throws -> [DailyUsage]
  /// How many sessions and messages a profile had over `days` days (`insights.get`).
  func insights(profile: String, days: Int) async throws -> InsightsSummary?
  /// The Nous account's balance (`usage.bars`); nil where there is none.
  func nousBars() async throws -> NousUsageBars?
  /// One live session's tokens, context window and account lines (`session.usage`); nil where the
  /// gateway had nothing to say.
  func session(runtimeID: String, profile: String) async throws -> SessionUsage?
  /// The provider accounts a profile's models run on, as fields (`account.usage`): plan, quota windows,
  /// credits. `profile` nil is the gateway's launch profile. `refresh` asks the gateway to read the providers
  /// again instead of from its cache, which it does at most once per 15 seconds. Nil where the gateway sent
  /// nothing usable; throws `UsageFailure.unsupported` on a gateway that has no such method.
  func accountUsage(profile: String?, refresh: Bool) async throws -> AccountUsage?
}

extension UsageBackend {
  /// A backend without the method (an older gateway, a test's script that has no account): the screens fall
  /// back to the text lines of `session.usage`.
  public func accountUsage(profile: String?, refresh: Bool) async throws -> AccountUsage? {
    throw UsageFailure.unsupported
  }
}

/**
 The gateway calls behind the usage screens, over one session's link.

 The daily numbers are a REST route and the rest are RPC; an RPC that a gateway does not have answers
 `-32601` (`UsageFailure.unsupported`), a REST route it does not have answers 404 (the same), and a link
 with no REST side (a test's scripted one) cannot read the days at all.
 */
public struct UsageService: UsageBackend {
  /// The longest span asked for, which is the route's own ceiling (`days` is clamped to 1…365).
  public static let maxDays = 365
  public static let route = "/api/analytics/usage"
  /// The fork's structured twin of `session.usage`'s account lines.
  public static let accountMethod = RPC.AccountUsage.name

  let link: any GatewayLink
  let rest: (any GatewayREST)?

  /// - Parameter rest: the REST side the days are read over; the link's own where it has one.
  public init(link: any GatewayLink, rest: (any GatewayREST)? = nil) {
    self.link = link
    self.rest = rest ?? (link as? any GatewayREST)
  }

  /// The route's path for one profile: `days` is clamped to what the route allows.
  static func path(profile: String, days: Int) -> String {
    let span = max(1, min(days, maxDays))

    return "\(route)?" + CapabilityText.query([("days", String(span)), ("profile", profile)])
  }

  public func daily(profile: String, days: Int) async throws -> [DailyUsage] {
    guard let rest else {
      throw UsageFailure.unsupported
    }

    do {
      let body = try await rest.restJSON("GET", Self.path(profile: profile, days: days), body: nil)

      guard case .object? = body else {
        throw UsageFailure.failed("")
      }

      return DailyUsage.parse(analytics: body)
    } catch {
      throw UsageFailure.classify(error)
    }
  }

  public func insights(profile: String, days: Int) async throws -> InsightsSummary? {
    let params: JSONValue = .object(["days": .number(Double(max(1, days))), "profile": .string(profile)])

    do {
      return InsightsSummary.parse(try await link.requestReply("insights.get", params: params).result)
    } catch {
      throw UsageFailure.classify(error)
    }
  }

  public func nousBars() async throws -> NousUsageBars? {
    do {
      return NousUsageBars.parse(try await link.requestReply("usage.bars", params: .object([:])).result)
    } catch {
      throw UsageFailure.classify(error)
    }
  }

  public func accountUsage(profile: String?, refresh: Bool) async throws -> AccountUsage? {
    var fields: [String: JSONValue] = [:]

    if let profile, !profile.isEmpty {
      fields["profile"] = .string(profile)
    }

    if refresh {
      fields["refresh"] = .bool(true)
    }

    do {
      return AccountUsage.parse(try await link.requestReply(Self.accountMethod, params: .object(fields)).result)
    } catch {
      throw UsageFailure.classify(error)
    }
  }

  public func session(runtimeID: String, profile: String) async throws -> SessionUsage? {
    let params: JSONValue = .object(["session_id": .string(runtimeID), "profile": .string(profile)])

    do {
      return SessionUsage.parse(try await link.requestReply(RPC.SessionUsage.name, params: params).result)
    } catch {
      throw UsageFailure.classify(error)
    }
  }
}
