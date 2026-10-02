import Foundation
import HermieGateway
import Synchronization

/// Why a sign-in attempt ended without a usable credential. The app owns the sentences; no case
/// carries a URL, a code or a token.
public enum SignInProblem: Error, Sendable, Equatable {
  /// Another app already listens on the callback port. The in-app page still works.
  case portInUse
  /// The loopback listener could not start for another reason.
  case listenerUnavailable
  /// The system browser session could not be shown.
  case browserUnavailable
  /// The person closed the sign-in.
  case cancelled
  /// The sign-in stayed open longer than `GatewayServices.signInTimeout`.
  case timedOut
  /// The sign-in could not be started (the gateway address does not make an authorize URL).
  case couldNotStart
  /// The callback did not belong to this attempt.
  case stateMismatch
  /// The callback carried no code.
  case noCode
  /// The in-app page tried to go somewhere on this device other than the gateway and the callback.
  case blockedNavigation
  /// The gateway or its identity provider refused.
  case provider(error: String, description: String)
  /// The code exchange failed.
  case exchange(GatewayErrorKind, status: Int?)
  /// The gateway refused the credential when it was checked.
  case rejected
  /// Checking the credential failed for another reason.
  case check(GatewayErrorKind, status: Int?)
  /// The in-app page could not be loaded.
  case pageLoad(status: Int?)

  /// The problem a failed `completeSignIn` or a failed navigation stands for.
  public init(_ error: any Error) {
    switch error {
    case let failure as SignInFailure:
      switch failure {
      case .stateMismatch: self = .stateMismatch
      case .blockedNavigation: self = .blockedNavigation
      case .provider(let error, let description): self = .provider(error: error, description: description)
      case .noCode, .noSignInPending, .notACallback: self = .noCode
      }
    case let error as GatewayError:
      self = .exchange(error.kind, status: error.status)
    case let error as SignInProblem:
      self = error
    default:
      self = .exchange(.config, status: nil)
    }
  }

  /// The problem a failed check of a fresh credential stands for.
  static func checking(_ error: any Error) -> SignInProblem {
    guard let error = error as? GatewayError else {
      return .check(.config, status: nil)
    }

    return error.kind == .auth ? .rejected : .check(error.kind, status: error.status)
  }
}

/// How a browser session ended without `close()`.
public enum BrowserSessionEnd: Sendable, Equatable {
  /// The person closed the sheet (or the browser window).
  case closedByPerson
  /// The system could not show it.
  case failed
}

/**
 The system browser's sign-in sheet, which HermieUI implements over `ASWebAuthenticationSession`. A
 shared (not ephemeral) browser session, so the identity provider's existing session, the browser's
 AutoFill, password-manager extensions and passkeys all work.
 */
@MainActor
public protocol BrowserSessionPresenting: AnyObject {
  /// Show `url`. Answers false when the session could not be started at all. `onEnd` is called once
  /// if the session ends by itself; never after `close()`.
  func open(_ url: URL, onEnd: @escaping @MainActor (BrowserSessionEnd) -> Void) -> Bool
  /// Dismiss the sheet. Idempotent.
  func close()
}

/**
 One sign-in through the system browser and the loopback listener (RFC 8252):

 1. `beginSignIn` makes a fresh verifier, challenge and state, and the authorize URL.
 2. The listener binds `127.0.0.1:38007` and takes only a callback whose state is this attempt's
    (`SignInNavigation.decide`); anything else is answered 400 and the listening goes on.
 3. The browser opens the authorize URL. Whatever the provider does there (a password page, an
    OIDC redirect, a passkey) ends in the browser asking for the callback.
 4. The first of: the callback, the person closing the sheet, the timeout, or the calling task being
    cancelled. The sheet is dismissed and the listener stopped at once, whichever it was.
 5. On a callback, `completeSignIn(redirectURL:)` checks the state again and redeems the code.
 */
public enum BrowserSignIn {
  private enum Event: Sendable {
    case callback(String)
    case listenerStopped(LoopbackListenerError?)
    case closedByPerson
    case browserFailed
    case timedOut
    case cancelled
  }

  @MainActor
  public static func run(
    credentials: NativePKCECredentials,
    provider: String?,
    listener: any LoopbackCallbackListening,
    presenter: any BrowserSessionPresenting,
    timeout: Duration,
    sleep: @escaping @Sendable (Duration) async throws -> Void
  ) async -> Result<TokenSet, SignInProblem> {
    let baseURL = credentials.baseURL
    // The listener comes first: its port is in the redirect URI the attempt is begun with. Until
    // then, the expected state is empty and nothing is taken.
    let expected = ExpectedCallback()
    let port: UInt16

    do {
      port = try await listener.start { candidate in
        let (state, redirectURI) = expected.value

        return SignInNavigation.decide(
          candidate,
          expectedState: state,
          gatewayBaseURL: baseURL,
          redirectURI: redirectURI
        ) == .callback
      }
    } catch {
      await listener.stop()

      if case LoopbackListenerError.portInUse = error {
        return .failure(.portInUse)
      }

      return .failure(.listenerUnavailable)
    }

    let redirectURI = LoopbackCallbackListener.redirectURI(port: port)
    let start: SignInStart

    do {
      start = try await credentials.beginSignIn(provider: provider, redirectURI: redirectURI)
    } catch {
      await listener.stop()
      return .failure(.couldNotStart)
    }

    let state = state(of: start.authorizeURL)

    guard let url = URL(string: start.authorizeURL), !state.isEmpty else {
      await listener.stop()
      await credentials.cancelSignIn()
      return .failure(.couldNotStart)
    }

    expected.set(state: state, redirectURI: redirectURI)

    let (events, sink) = AsyncStream<Event>.makeStream()
    let listening = Task {
      do {
        sink.yield(.callback(try await listener.callback()))
      } catch {
        sink.yield(.listenerStopped(error as? LoopbackListenerError))
      }
    }
    let timer = Task {
      do {
        try await sleep(timeout)
        sink.yield(.timedOut)
      } catch {}
    }

    let opened = presenter.open(url) { end in
      sink.yield(end == .closedByPerson ? .closedByPerson : .browserFailed)
    }

    if !opened {
      sink.yield(.browserFailed)
    }

    let first = await withTaskCancellationHandler {
      var iterator = events.makeAsyncIterator()
      return await iterator.next() ?? .cancelled
    } onCancel: {
      sink.yield(.cancelled)
    }

    sink.finish()
    timer.cancel()
    listening.cancel()
    presenter.close()
    await listener.stop()

    let problem: SignInProblem

    switch first {
    case .callback(let redirect):
      do {
        return .success(try await credentials.completeSignIn(redirectURL: redirect))
      } catch {
        return .failure(SignInProblem(error))
      }
    case .closedByPerson, .cancelled:
      problem = .cancelled
    case .browserFailed:
      problem = .browserUnavailable
    case .timedOut:
      problem = .timedOut
    case .listenerStopped(.portInUse?):
      problem = .portInUse
    case .listenerStopped:
      problem = .listenerUnavailable
    }

    await credentials.cancelSignIn()
    return .failure(problem)
  }

  /// The `state` the authorize URL carries: the value the callback must echo.
  static func state(of authorizeURL: String) -> String {
    URLComponents(string: authorizeURL)?.queryItems?.first { $0.name == "state" }?.value ?? ""
  }
}

/// The state and redirect URI a callback must carry, set once the attempt has begun.
final class ExpectedCallback: Sendable {
  private let current = Mutex<(state: String, redirectURI: String)>(("", ""))

  var value: (state: String, redirectURI: String) { current.withLock { $0 } }

  func set(state: String, redirectURI: String) {
    current.withLock { $0 = (state, redirectURI) }
  }
}
