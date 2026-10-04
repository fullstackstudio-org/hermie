#if os(macOS)
  import AppKit
  import HermieGateway
  import Observation
  import SwiftUI
  import Testing

  @testable import HermieUI

  /// The connection banner follows the connection: it shows a moment after the connection drops,
  /// and goes the moment it is ready again, however quickly the phases follow each other.
  @MainActor
  @Suite(.serialized) struct ConnectionBannerTests {
    @MainActor @Observable final class Connection {
      var status = ConnectionStatus(.disconnected)
    }

    /// The banner reading the status from an observed model, as the chat list's inset reads the
    /// session's. It takes no room while hidden, so its height says whether it shows.
    struct Host: View {
      let connection: Connection

      var body: some View {
        ConnectionBanner(status: connection.status)
          .frame(width: 320)
          .fixedSize(horizontal: false, vertical: true)
      }
    }

    private func host(_ connection: Connection) -> (NSHostingView<Host>, NSWindow) {
      let view = NSHostingView(rootView: Host(connection: connection))
      view.frame = NSRect(x: 0, y: 0, width: 320, height: 240)
      let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.contentView = view
      window.orderFrontRegardless()
      return (view, window)
    }

    /// Suspends the test, so the main actor runs SwiftUI's updates and the banner's own task
    /// meanwhile. (A run loop spun inside the test's job cannot: the main actor is busy with it.)
    private func spin(_ seconds: Double) async {
      try? await Task.sleep(for: .seconds(seconds))
    }

    private func bannerShown(_ view: NSView) -> Bool {
      view.layoutSubtreeIfNeeded()
      return view.fittingSize.height > 10
    }

    @Test func theBannerClearsOnceReadyAndComesBackOnADrop() async {
      let connection = Connection()
      let (view, window) = host(connection)
      defer { window.close() }

      // Waited for rather than looked at once after a fixed pause: with the other suites hosting
      // views on the main actor beside this one, the banner's own 900 ms task can land later.
      connection.status = ConnectionStatus(.connecting)
      #expect(await settles(view, shown: true, within: 5), "connecting for over a second: the banner is up")

      connection.status = ConnectionStatus(.ready)
      #expect(await settles(view, shown: false, within: 3), "ready: the banner is gone")

      connection.status = ConnectionStatus(.reconnecting)
      #expect(await settles(view, shown: true, within: 5), "a drop: the banner is back")

      connection.status = ConnectionStatus(.ready)
      #expect(await settles(view, shown: false, within: 3))
    }

    /// Whether the banner comes to `shown` within `seconds`.
    private func settles(_ view: NSView, shown: Bool, within seconds: Double) async -> Bool {
      let deadline = ContinuousClock.now + .seconds(seconds)

      while ContinuousClock.now < deadline {
        if bannerShown(view) == shown {
          return true
        }

        await spin(0.05)
      }

      return bannerShown(view) == shown
    }

    @Test func aBannerThatIsUpClearsWhenReadyFollowsAnotherPhaseAtOnce() async {
      // A reconnect reports reconnecting, connecting, ready in quick succession.
      let connection = Connection()
      let (view, window) = host(connection)
      defer { window.close() }

      connection.status = ConnectionStatus(.reconnecting)
      await spin(1.4)
      #expect(bannerShown(view))
      connection.status = ConnectionStatus(.connecting)
      await spin(0.05)
      connection.status = ConnectionStatus(.ready)
      await spin(1.4)
      #expect(!bannerShown(view), "ready: the banner is gone")
    }

    @Test func signInShowsAtOnce() async {
      let connection = Connection()
      let (view, window) = host(connection)
      defer { window.close() }
      #expect(!bannerShown(view))
      connection.status = ConnectionStatus(.needsSignin)
      await spin(0.6)
      #expect(bannerShown(view))
    }

    @Test func aConnectionThatIsReadyWithinTheGraceNeverShowsTheBanner() async {
      let connection = Connection()
      let (view, window) = host(connection)
      defer { window.close() }

      connection.status = ConnectionStatus(.connecting)
      await spin(0.3)
      connection.status = ConnectionStatus(.ready)
      await spin(1.4)
      #expect(!bannerShown(view), "ready before the grace ran out: nothing shows, then or later")
    }
  }
#endif
