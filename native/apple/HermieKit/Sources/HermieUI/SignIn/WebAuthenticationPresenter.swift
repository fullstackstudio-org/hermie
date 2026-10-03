import AuthenticationServices
import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// The parts of `ASWebAuthenticationSession` the presenter drives, so a test can stand in for it.
@MainActor
protocol WebAuthenticationSessionDriving: AnyObject {
  var prefersEphemeralWebBrowserSession: Bool { get set }
  var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)? { get set }
  var canStart: Bool { get }
  func start() -> Bool
  func cancel()
}

extension ASWebAuthenticationSession: WebAuthenticationSessionDriving {}

/// The handler the system calls when a session ends. `@Sendable`, so it is never isolated to the
/// main actor: AuthenticationServices calls it on whatever queue it likes (on the Mac, a background
/// XPC queue when the person picks "Open in browser" or when a cancelled session winds down), and a
/// main-actor closure called there traps in Swift 6's isolation check (TestFlight 0.2.1, build 711).
typealias WebAuthenticationCompletion = @Sendable (URL?, (any Error)?) -> Void

/// Makes the session for a URL and a callback scheme, with the handler the system calls.
typealias WebAuthenticationSessionFactory = @MainActor (
  URL, String, @escaping WebAuthenticationCompletion
) -> any WebAuthenticationSessionDriving

/// The window a view is in, for whatever must be presented from it (the browser sign-in sheet).
@MainActor
final class PresentationAnchorBox {
  weak var window: ASPresentationAnchor?
}

/// The window the open session is shown from, found on the main thread before the session starts,
/// so AuthenticationServices can ask for it from any thread without waiting on the main one.
private final class PresentingWindow: @unchecked Sendable {
  private let lock = NSLock()
  private weak var stored: ASPresentationAnchor?

  var window: ASPresentationAnchor? {
    lock.withLock { stored }
  }

  func set(_ window: ASPresentationAnchor) {
    lock.withLock { stored = window }
  }
}

/**
 The browser sign-in sheet, over `ASWebAuthenticationSession`.

 Not ephemeral (`prefersEphemeralWebBrowserSession = false`): the session shares the browser's cookies,
 so the identity provider's existing sign-in, the browser's AutoFill, password-manager extensions and
 passkeys all work there. The session never completes by itself: its callback scheme is one nothing
 redirects to, because the result arrives at the loopback listener (`BrowserSignIn`), which then
 closes the sheet.

 It is presented from outside the views of the flow, so the app lock, which takes those views down,
 cannot take the browser with them: on iOS from a window of its own above the app (transparent, and
 passing every touch through), on the Mac as a sheet of the main window rather than of the setup
 sheet. The presenter itself is kept by `SetupSessions` for as long as the flow runs.

 Everything AuthenticationServices calls back into is `nonisolated`: the completion handler and the
 presentation anchor may come on any thread. Both only read what the main actor prepared, or hop to
 it.
 */
@MainActor
final class WebAuthenticationPresenter: NSObject, BrowserSessionPresenting, ASWebAuthenticationPresentationContextProviding {
  /// A scheme nobody registers or redirects to, so only `close()` or the person ends the session.
  static let unusedCallbackScheme = "dev.hermie.signin-loopback"

  let anchor = PresentationAnchorBox()
  private let makeSession: WebAuthenticationSessionFactory
  private var session: (any WebAuthenticationSessionDriving)?
  private var onEnd: (@MainActor (BrowserSessionEnd) -> Void)?
  /// Counts `open` calls: the end of a session reports only while it is still the open one.
  private var attempt = 0
  private nonisolated let presenting = PresentingWindow()
  #if os(iOS)
    private var overlay: UIWindow?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  #endif

  init(makeSession: @escaping WebAuthenticationSessionFactory = WebAuthenticationPresenter.systemSession) {
    self.makeSession = makeSession
  }

  /// The system's session. The handler goes to it as it is: wrapping it in a closure written here
  /// would make that closure the main actor's again.
  static let systemSession: WebAuthenticationSessionFactory = { url, scheme, completion in
    ASWebAuthenticationSession(url: url, callback: .customScheme(scheme), completionHandler: completion)
  }

  func open(_ url: URL, onEnd: @escaping @MainActor (BrowserSessionEnd) -> Void) -> Bool {
    close()
    attempt += 1

    let session = makeSession(url, Self.unusedCallbackScheme, Self.completion(attempt: attempt, presenter: self))

    session.prefersEphemeralWebBrowserSession = false
    presenting.set(currentAnchor())
    session.presentationContextProvider = self
    self.session = session
    self.onEnd = onEnd

    guard session.canStart, session.start() else {
      self.session = nil
      self.onEnd = nil
      hideOverlay()
      return false
    }

    return true
  }

  func close() {
    let closing = session

    session = nil
    onEnd = nil
    closing?.cancel()
    hideOverlay()
    endBackgroundTask()
  }

  /// The handler for the session of `attempt`. Built outside the main actor, so it is not isolated to
  /// it; all it does on the calling thread is read the error, then it hops to the main actor.
  nonisolated static func completion(attempt: Int, presenter: WebAuthenticationPresenter) -> WebAuthenticationCompletion {
    { [weak presenter] _, error in
      let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin

      Task { @MainActor [presenter] in
        presenter?.sessionEnded(attempt: attempt, cancelled: cancelled)
      }
    }
  }

  /// Only the session still open speaks: a late answer from one already closed (or replaced) must
  /// neither end the next one nor report for it.
  private func sessionEnded(attempt ended: Int, cancelled: Bool) {
    guard ended == attempt, session != nil, let onEnd else {
      return
    }

    session = nil
    self.onEnd = nil
    hideOverlay()
    onEnd(cancelled ? .closedByPerson : .failed)
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    if let window = presenting.window {
      return window
    }

    // Asked before `open` set one, or after the window went: find it on the main thread.
    if Thread.isMainThread {
      return MainActor.assumeIsolated { currentAnchor() }
    }

    return DispatchQueue.main.sync { MainActor.assumeIsolated { currentAnchor() } }
  }

  /// The window to show the sheet from.
  private func currentAnchor() -> ASPresentationAnchor {
    #if os(iOS)
      return overlayWindow()
    #else
      // The main window, not the setup sheet: a sheet goes when the lock takes the content down.
      if let window = anchor.window {
        return window.sheetParent ?? window
      }

      return NSApplication.shared.mainWindow ?? NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first
        ?? NSWindow()
    #endif
  }

  // MARK: - The app's comings and goings

  /// The app went to the background with the sheet up: ask iOS for the time it grants to finish.
  func appWentToBackground() {
    #if os(iOS)
      guard session != nil, backgroundTask == .invalid else {
        return
      }

      backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Hermie sign-in") { [weak self] in
        MainActor.assumeIsolated { self?.endBackgroundTask() }
      }
    #endif
  }

  func appBecameActive() {
    endBackgroundTask()
  }

  private func endBackgroundTask() {
    #if os(iOS)
      guard backgroundTask != .invalid else {
        return
      }

      UIApplication.shared.endBackgroundTask(backgroundTask)
      backgroundTask = .invalid
    #endif
  }

  // MARK: - iOS: a window of its own

  #if os(iOS)
    private func overlayWindow() -> UIWindow {
      if let overlay {
        return overlay
      }

      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      let scene = anchor.window?.windowScene ?? scenes.first { $0.activationState == .foregroundActive } ?? scenes[0]
      let window = PassThroughWindow(windowScene: scene)
      let root = UIViewController()

      root.view.backgroundColor = .clear
      window.rootViewController = root
      window.windowLevel = .normal + 1
      window.isHidden = false
      overlay = window
      return window
    }
  #endif

  private func hideOverlay() {
    #if os(iOS)
      overlay?.isHidden = true
      overlay = nil
    #endif
  }
}

#if os(iOS)
  /// A window that only takes the touches meant for what it presents.
  private final class PassThroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
      let view = super.hitTest(point, with: event)

      return view === rootViewController?.view ? nil : view
    }
  }
#endif

/// Puts the window this view is in into a `PresentationAnchorBox`.
struct PresentationAnchorReader: View {
  let box: PresentationAnchorBox

  var body: some View {
    Representable(box: box)
      .frame(width: 0, height: 0)
      .accessibilityHidden(true)
  }

  #if os(iOS)
    private struct Representable: UIViewRepresentable {
      let box: PresentationAnchorBox

      func makeUIView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.box = box
        return view
      }

      func updateUIView(_ view: ReaderView, context: Context) {
        view.box = box

        if let window = view.window {
          box.window = window
        }
      }
    }

    final class ReaderView: UIView {
      var box: PresentationAnchorBox?

      override func didMoveToWindow() {
        super.didMoveToWindow()

        if let window {
          box?.window = window
        }
      }
    }
  #else
    private struct Representable: NSViewRepresentable {
      let box: PresentationAnchorBox

      func makeNSView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.box = box
        return view
      }

      func updateNSView(_ view: ReaderView, context: Context) {
        view.box = box

        if let window = view.window {
          box.window = window
        }
      }
    }

    final class ReaderView: NSView {
      var box: PresentationAnchorBox?

      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()

        if let window {
          box?.window = window
        }
      }
    }
  #endif
}
