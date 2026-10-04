import SwiftUI
import Testing

@testable import HermieUI

/// The gateway menus' titles, and the Mac menu bar's Gateway menu.
@MainActor
@Suite struct GatewayMenuTests {
  @Test func aTitleIsCutInTheMiddleKeepingItsStartAndItsEnd() {
    let title = "hermes.fullstackstudio.nl"
    let cut = MenuTitle.middleTruncated(title) { $0.count <= 12 }
    #expect(cut.count <= 12)
    #expect(cut.contains("…"))
    #expect(cut.hasPrefix("herm"))
    #expect(cut.hasSuffix(".nl"))
    #expect(MenuTitle.middleTruncated("short") { $0.count <= 12 } == "short", "a title that fits stays whole")
  }

  #if os(macOS)
    @Test func theFirstNineGatewaysHaveCommandOneToNine() {
      #expect(GatewayMenu.shortcut(at: 0) == KeyEquivalent("1"))
      #expect(GatewayMenu.shortcut(at: 8) == KeyEquivalent("9"))
      #expect(GatewayMenu.shortcut(at: 9) == nil)
      #expect(GatewayMenu.shortcut(at: -1) == nil)
    }

    @Test func aLongHostNameIsCutForTheMenuBarAndAShortOneIsNot() {
      let long = "a-very-long-gateway-host-name-for-a-staging-cluster.eu-west.internal.fullstackstudio.nl"
      let fitted = MenuTitle.fitted(long, typeSize: .large)
      #expect(fitted != long)
      #expect(fitted.contains("…"))
      #expect(fitted.hasSuffix(".nl"))
      #expect(MenuTitle.fitted("Home", typeSize: .large) == "Home")
    }
  #endif
}
