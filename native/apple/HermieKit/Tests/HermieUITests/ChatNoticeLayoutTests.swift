import Foundation
import HermieGateway
import SwiftUI
import Testing

@testable import HermieCore
@testable import HermieUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// A notice over the chat, however long, leaves the window as it is: the chat list stays in view on
/// the left and the composer at the bottom of the chat.
///
/// The owner's "everything out of view" on the Mac: a message sent while another Hermes window or
/// terminal had the chat open came back with the gateway's refusal ("This chat is open in another
/// Hermes window/terminal. … Details: session … opened by cli 4m ago."), shown over the composer. The
/// notice wraps its text (`fixedSize(vertical:)`), and SwiftUI measures the window's minimum size at
/// the narrowest width it probes, where the sentence takes a line every few letters: the chat's
/// minimum height went from the window's 420 points to some 2,700, the split view was laid out that
/// tall and centred in the window, the chat list's rows ran off the top (a blank sidebar) and the
/// composer off the bottom.
@MainActor
@Suite(.serialized) struct ChatNoticeLayoutTests {
  /// The gateway's refusal, word for word (the fork's `session_already_owned_message`).
  nonisolated static let refusal =
    "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\n"
    + "Details: session 20260923_143304_1025bb opened by cli 4m ago."
  /// A notice with no place to break a line.
  nonisolated static let unbreakable = String(repeating: "x", count: 5000)
  /// The refusal as it came before (the gateway's words) and as it comes now, and both again with
  /// a string that cannot break.
  nonisolated static let notices: [ComposerNotice] = [
    .failed(refusal), .openElsewhere(details: "session 20260923_143304_1025bb opened by cli 4m ago."),
    .failed(unbreakable), .openElsewhere(details: unbreakable)
  ]

  let session = GatewaySession(gatewayID: "notice-layout", link: UnreachableLink())

  /// The size SwiftUI gives `view` at `width` and any height it likes, on either platform.
  static func height(of view: some View, width: CGFloat) -> CGFloat {
    let proposal = CGSize(width: width, height: .greatestFiniteMagnitude)

    #if os(macOS)
      return NSHostingController(rootView: view).sizeThatFits(in: proposal).height
    #else
      return UIHostingController(rootView: view).sizeThatFits(in: proposal).height
    #endif
  }

  // MARK: The notices' own size (shared by the Mac, iPhone and iPad)

  @Test(arguments: notices.indices)
  func aComposerNoticeTakesAFewLinesAtAnyWidth(case index: Int) {
    let notice = Self.notices[index]
    let model = ComposerModel(session: session, bot: "writer")
    let bare = Self.height(of: ComposerView(model: model), width: 400)
    model.notice = notice

    // A phone's width: a few lines. The narrowest width SwiftUI probes for a minimum, where every
    // letter takes a line: still a few lines, whatever the length of the text (the refusal took
    // some 2,300 points there, a 5,000-letter notice 65,000).
    for (width, limit) in [(CGFloat(400), CGFloat(120)), (1, 480)] {
      let height = Self.height(of: ComposerView(model: model), width: width) - bare
      #expect(height < limit, "at \(width) points the notice is \(height) points tall")
    }
  }

  @Test func theChatsBannersTakeAFewLinesAtAnyWidth() throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "notice-layout", bot: "writer"), session: session) { _ in .none }
    }
    let feed = try #require(owner.feed)
    feed.optionNotice = .warning(Self.unbreakable)
    feed.recordOpenFailure(GatewayError(.network, Self.unbreakable))

    for width in [CGFloat(1), 400] {
      let height = Self.height(of: ChatBanners(feed: feed), width: width)
      #expect(height < 520, "at \(width) points the banners are \(height) points tall")
    }
  }

  // MARK: The Mac window

  #if os(macOS)
    @MainActor final class Probe {
      var composer: ComposerModel?
      var composerFrame = CGRect.zero
      var chatFrame = CGRect.zero
      var rows: [Int: CGRect] = [:]
    }

    /// The main window's layout: the chat list in the sidebar, the chat with the standard composer
    /// in the detail column, the window's minimum size as the app sets it.
    struct Shell: View {
      let session: GatewaySession
      let probe: Probe

      var body: some View {
        NavigationSplitView {
          List(0..<20, id: \.self) { index in
            Text("Bot \(index)")
              .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { probe.rows[index] = $0 }
          }
        } detail: {
          ChatSessionView(chat: ChatRef(gatewayId: "notice-layout", bot: "writer"), session: session, actions: nil) {
            (context: ChatComposerContext) -> AnyView in
            probe.composer = context.composer
            return AnyView(
              StandardComposer(context: context)
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { probe.composerFrame = $0 })
          }
          .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { probe.chatFrame = $0 }
        }
        .frame(minWidth: 640, minHeight: 420)
      }
    }

    /// Lets SwiftUI run its updates, then puts the window back at `size` the way a window takes on
    /// its content's minimum, and lets it lay out again.
    private func settle(_ window: NSWindow, at size: NSSize) async {
      try? await Task.sleep(for: .milliseconds(400))
      window.setContentSize(size)
      try? await Task.sleep(for: .milliseconds(400))
    }

    @Test(arguments: notices.indices)
    func aNoticeOverTheComposerLeavesTheWindowAsItIs(case index: Int) async throws {
      let notice = Self.notices[index]
      for size in [NSSize(width: 1000, height: 680), NSSize(width: 640, height: 420)] {
        let probe = Probe()
        let host = NSHostingView(rootView: Shell(session: session, probe: probe))
        let window = NSWindow(
          contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered,
          defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.close() }

        await settle(window, at: size)
        let before = window.frame
        let composer = try #require(probe.composer)

        composer.notice = notice
        await settle(window, at: size)

        let bottom = window.frame.height + 0.5
        #expect(window.frame == before, "\(size): the window kept its frame")
        #expect(host.fittingSize.height <= size.height, "\(size): the window's minimum is \(host.fittingSize.height) points tall")
        #expect(
          probe.chatFrame.minY >= -0.5 && probe.chatFrame.maxY <= bottom,
          "\(size): the chat (\(probe.chatFrame)) is inside the window (\(window.frame.height) tall)")
        #expect(
          probe.composerFrame.minY > probe.chatFrame.minY && probe.composerFrame.maxY <= bottom,
          "\(size): the composer (\(probe.composerFrame)) is inside the window")
        #expect(
          probe.composerFrame.height < size.height / 2,
          "\(size): the composer with its notice (\(probe.composerFrame.height) tall) leaves room for the transcript")
        let first = try #require(probe.rows[0])
        #expect(first.minY >= 0 && first.maxY <= bottom, "\(size): the chat list's first row (\(first)) is in view")
      }
    }
  #endif
}
