import Foundation
import HermieGateway
import Observation

/**
 The fallback sign-in: the gateway's page in a web view inside Hermie (ADR-0004), for when the system
 browser cannot be used (another app holds the callback port, or the person chose it).

 The web view asks `decide(_:)` about every navigation, and `NativePKCECredentials.decision(for:)`
 rules: only http and https load, nothing on this device loads except the gateway's own origin, and
 the callback is never loaded at all but taken out and redeemed. No loopback listener runs in this
 mode. The web view keeps nothing: it gets a non-persistent data store per attempt.
 */
@MainActor
@Observable
public final class InAppSignInAttempt: Identifiable {
  public enum Phase: Sendable, Equatable {
    case loading
    case exchanging
    case finished
    case failed(SignInProblem)
  }

  public enum Verdict: Sendable, Equatable {
    case allow
    case cancel
  }

  public let id = UUID()
  public let authorizeURL: URL
  /// The gateway's address: the one origin whose page may run the front door's script.
  public let baseURL: String
  /// Sent on the first load only. A web view does not repeat them on a redirect to another origin.
  public let headers: [String: String]
  /// The front door's document-start script (`FrontDoor.accessUserScript`), or empty.
  public let userScript: String
  public private(set) var phase: Phase = .loading

  /// The `state` the authorize URL carries.
  private var expectedState: String {
    URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value ?? ""
  }

  @ObservationIgnored private let credentials: NativePKCECredentials
  @ObservationIgnored private let onResult: @MainActor (Result<TokenSet, SignInProblem>) -> Void

  init(
    authorizeURL: URL,
    baseURL: String,
    headers: [String: String],
    userScript: String,
    credentials: NativePKCECredentials,
    onResult: @escaping @MainActor (Result<TokenSet, SignInProblem>) -> Void
  ) {
    self.authorizeURL = authorizeURL
    self.baseURL = baseURL
    self.headers = headers
    self.userScript = userScript
    self.credentials = credentials
    self.onResult = onResult
  }

  /// Begin an attempt on `credentials`: a fresh verifier, challenge and state.
  static func begin(
    credentials: NativePKCECredentials,
    provider: String?,
    headers: [String: String],
    frontDoor: FrontDoor,
    onResult: @escaping @MainActor (Result<TokenSet, SignInProblem>) -> Void
  ) async -> InAppSignInAttempt? {
    guard let start = try? await credentials.beginSignIn(provider: provider), let url = URL(string: start.authorizeURL)
    else {
      return nil
    }

    return InAppSignInAttempt(
      authorizeURL: url,
      baseURL: credentials.baseURL,
      headers: headers,
      userScript: frontDoor.accessUserScript(for: credentials.baseURL),
      credentials: credentials,
      onResult: onResult
    )
  }

  /// What the web view should do with one navigation. The callback is never loaded.
  public func decide(_ url: String) async -> Verdict {
    guard phase == .loading else {
      return .cancel
    }

    // An error callback ends the attempt only when it carries this attempt's state, the same rule
    // as a code: anything else could end it from outside.
    if case .fail(.provider) = SignInNavigation.decide(url, expectedState: expectedState, gatewayBaseURL: baseURL),
      URLComponents(string: url)?.queryItems?.first(where: { $0.name == "state" })?.value != expectedState
    {
      Task { await credentials.cancelSignIn() }
      finish(.failure(.stateMismatch))
      return .cancel
    }

    switch await credentials.decision(for: url) {
    case .allow:
      return phase == .loading ? .allow : .cancel
    case .callback:
      guard phase == .loading else {
        return .cancel
      }

      phase = .exchanging
      Task { await complete(url) }
      return .cancel
    case .fail(let failure):
      finish(.failure(SignInProblem(failure)))
      return .cancel
    }
  }

  /// The page the attempt opened could not be loaded.
  public func pageFailed(status: Int?) {
    guard phase == .loading else {
      return
    }

    Task { await credentials.cancelSignIn() }
    finish(.failure(.pageLoad(status: status)))
  }

  /// The person closed the page, or the attempt timed out.
  public func cancel(_ problem: SignInProblem = .cancelled) {
    guard phase == .loading || phase == .exchanging else {
      return
    }

    Task { await credentials.cancelSignIn() }
    finish(.failure(problem))
  }

  private func complete(_ url: String) async {
    do {
      let tokens = try await credentials.completeSignIn(redirectURL: url)

      finish(.success(tokens))
    } catch {
      finish(.failure(SignInProblem(error)))
    }
  }

  private func finish(_ result: Result<TokenSet, SignInProblem>) {
    switch phase {
    case .finished, .failed:
      return
    default:
      break
    }

    switch result {
    case .success:
      phase = .finished
    case .failure(let problem):
      phase = .failed(problem)
    }

    onResult(result)
  }
}
