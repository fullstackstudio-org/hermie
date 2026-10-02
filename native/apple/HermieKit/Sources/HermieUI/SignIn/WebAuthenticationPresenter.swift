import AuthenticationServices
import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// The window a view is in, for whatever must be presented from it (the browser sign-in sheet).
@MainActor
final class PresentationAnchorBox {
  weak var window: ASPresentationAnchor?
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
 */
@MainActor
final class WebAuthenticationPresenter: NSObject, BrowserSessionPresenting, ASWebAuthenticationPresentationContextProviding {
  /// A scheme nobody registers or redirects to, so only `close()` or the person ends the session.
  static let unusedCallbackScheme = "dev.hermie.signin-loopback"

  let anchor = PresentationAnchorBox()
  private var session: ASWebAuthenticationSession?
  #if os(iOS)
    private var overlay: UIWindow?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  #endif

  func open(_ url: URL, onEnd: @escaping @MainActor (BrowserSessionEnd) -> Void) -> Bool {
    close()

    var opened: ASWebAuthenticationSession?
    let session = ASWebAuthenticationSession(url: url, callback: .customScheme(Self.unusedCallbackScheme)) {
      [weak self] _, error in
      let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin

      Task { @MainActor [weak self] in
        // Only the session still open speaks: a late answer from one already closed (or replaced)
        // must neither end the next one nor report for it.
        guard let self, let opened, self.session === opened else {
          return
        }

        self.session = nil
        self.hideOverlay()
        onEnd(cancelled ? .closedByPerson : .failed)
      }
    }

    opened = session
    session.prefersEphemeralWebBrowserSession = false
    session.presentationContextProvider = self
    self.session = session

    guard session.canStart, session.start() else {
      self.session = nil
      hideOverlay()
      return false
    }

    return true
  }

  func close() {
    let closing = session

    session = nil
    closing?.cancel()
    hideOverlay()
    endBackgroundTask()
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
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
