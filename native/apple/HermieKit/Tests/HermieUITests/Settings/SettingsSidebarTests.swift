import SwiftUI
import Testing

@testable import HermieUI

@Suite("The Settings sidebar")
struct SettingsSidebarTests {
  @Test("every category is in exactly one group, and the groups keep the declared order")
  func groupsCoverEveryCategoryOnce() {
    let flat = SettingsCategory.groups.flatMap { $0 }
    #expect(flat == SettingsCategory.allCases)
    #expect(SettingsCategory.groups.allSatisfy { !$0.isEmpty })
  }

  @Test("Account opens the list and About closes it")
  func listEnds() {
    #expect(SettingsCategory.groups.first?.first == .account)
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
