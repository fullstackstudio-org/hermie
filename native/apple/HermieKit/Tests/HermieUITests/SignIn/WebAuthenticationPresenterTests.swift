import AuthenticationServices
import Foundation
import HermieCore
import Testing

@testable import HermieUI

/**
 The real `ASWebAuthenticationSession` the presenter made, held back from the screen: `start()` only
 counts. The test then makes the real session end itself on a background queue, the way the Mac
 does when the person picks "Open in browser" (`_startDryRun:` answering over XPC): a session
 started without a presentation context cancels itself, and calls its completion handler on the
 thread that started it.
 */
@MainActor
private final class HeldSession: WebAuthenticationSessionDriving {
  let real: ASWebAuthenticationSession
  var started = 0
  var cancelled = 0

  init(real: ASWebAuthenticationSession) {
    self.real = real
  }

  var prefersEphemeralWebBrowserSession: Bool {
    get { real.prefersEphemeralWebBrowserSession }
    set { real.prefersEphemeralWebBrowserSession = newValue }
  }

  var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)? {
    get { real.presentationContextProvider }
    set { real.presentationContextProvider = newValue }
  }

  var canStart: Bool { real.canStart }

  func start() -> Bool {
    started += 1
    return true
  }

  func cancel() {
    cancelled += 1
  }
}

/// The session, for a closure that runs on another queue (the system's class is not `Sendable`).
private final class Unchecked<Value>: @unchecked Sendable {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }
}

@MainActor
private final class Sessions {
  var made: [HeldSession] = []

  var factory: WebAuthenticationSessionFactory {
    { [unowned self] url, scheme, completion in
      let session = HeldSession(real: WebAuthenticationPresenter.systemSession(url, scheme, completion) as! ASWebAuthenticationSession)

      made.append(session)
      return session
    }
  }
}

/// Makes the real session call its completion handler on a global queue, and waits for that.
@MainActor
private func endOffMain(_ session: HeldSession) async {
  session.real.presentationContextProvider = nil

  let real = Unchecked(session.real)

  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    DispatchQueue.global(qos: .userInitiated).async {
      // No presentation context: the session ends at once, with its handler called right here.
      _ = real.value.start()
      done.resume()
    }
  }
}

@MainActor
@Suite("WebAuthenticationPresenter")
struct WebAuthenticationPresenterTests {
  private let url = URL(string: "https://gateway.example/auth/native/authorize?state=s")!

  @Test("the system ending the session on a background queue does not trap, and is reported")
  func completionOffMainQueue() async throws {
    let sessions = Sessions()
    let presenter = WebAuthenticationPresenter(makeSession: sessions.factory)
    var ends: [BrowserSessionEnd] = []

    #expect(presenter.open(url) { ends.append($0) })

    let session = try #require(sessions.made.first)

    #expect(session.started == 1)
    #expect(session.prefersEphemeralWebBrowserSession == false)

    await endOffMain(session)
    await until { !ends.isEmpty }

    // Not the person's doing (no `canceledLogin`): the sheet could not be shown.
    #expect(ends == [.failed])
  }

  @Test("the end of a session already closed says nothing, from any queue")
  func lateCompletionAfterClose() async throws {
    let sessions = Sessions()
    let presenter = WebAuthenticationPresenter(makeSession: sessions.factory)
    var ends: [BrowserSessionEnd] = []

    #expect(presenter.open(url) { ends.append($0) })

    let session = try #require(sessions.made.first)

    // What `BrowserSignIn` does once the loopback callback arrived; on the Mac, with the sign-in in
    // the browser, the session's end then comes back on a background queue.
    presenter.close()
    #expect(session.cancelled == 1)

    await endOffMain(session)
    try await Task.sleep(for: .milliseconds(100))

    #expect(ends.isEmpty)
  }

  @Test("a late end of a replaced session does not end the next one")
  func lateCompletionOfReplacedSession() async throws {
    let sessions = Sessions()
    let presenter = WebAuthenticationPresenter(makeSession: sessions.factory)
    var ends: [BrowserSessionEnd] = []

    #expect(presenter.open(url) { _ in Issue.record("the first session must not report") })
    #expect(presenter.open(url) { ends.append($0) })
    #expect(sessions.made.count == 2)

    await endOffMain(sessions.made[0])
    try await Task.sleep(for: .milliseconds(100))
    #expect(ends.isEmpty)

    await endOffMain(sessions.made[1])
    await until { !ends.isEmpty }
    #expect(ends == [.failed])
  }

  @Test("the presentation anchor can be asked for off the main thread")
  func presentationAnchorOffMain() async throws {
    let sessions = Sessions()
    let presenter = WebAuthenticationPresenter(makeSession: sessions.factory)

    #expect(presenter.open(url) { _ in })

    let session = try #require(sessions.made.first)
    let provider = Unchecked(try #require(session.presentationContextProvider) as AnyObject)
    let real = Unchecked(session.real)

    // Through the Objective-C entry point, the way AuthenticationServices asks.
    let answered = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.global().async {
        let selector = NSSelectorFromString("presentationAnchorForWebAuthenticationSession:")
        let anchor = provider.value.perform(selector, with: real.value)?.takeUnretainedValue()

        done.resume(returning: anchor != nil)
      }
    }

    #expect(answered)
    presenter.close()
  }

  private func until(_ condition: @MainActor () -> Bool) async {
    for _ in 0..<200 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }
}
