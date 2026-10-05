import SwiftUI
import Testing

@testable import HermieUI

@Suite("The Settings sidebar")
struct SettingsSidebarTests {
  @Test("every category is in exactly one group, and the groups keep the declared order")
  func groupsCoverEveryCategoryOnce() {
    let flat = SettingsCategory.groups.flatMap { $0 }
    // General is the Mac's own page: iPhone and iPad do not list it.
    #if os(macOS)
      #expect(flat == SettingsCategory.allCases)
    #else
      #expect(flat == SettingsCategory.allCases.filter { $0 != .general })
    #endif
    #expect(SettingsCategory.groups.allSatisfy { !$0.isEmpty })
  }

  @Test("General opens the Mac's list, Account opens the others, and About closes both")
  func listEnds() {
    #if os(macOS)
      #expect(SettingsCategory.groups.first == [.general])
    #else
      #expect(SettingsCategory.groups.first?.first == .account)
    #endif
    #expect(SettingsCategory.groups.last?.last == .about)
  }

  @Test("a collapsed sidebar is the detail-only column layout, and only that")
  func collapsedState() {
    #expect(SettingsSidebarState.visibility(hidden: true) == .detailOnly)
    #expect(SettingsSidebarState.visibility(hidden: false) == .all)
    #expect(SettingsSidebarState.isHidden(.detailOnly))
    #expect(!SettingsSidebarState.isHidden(.all))
    #expect(!SettingsSidebarState.isHidden(.automatic))
    #expect(!SettingsSidebarState.isHidden(.doubleColumn))
  }
}
