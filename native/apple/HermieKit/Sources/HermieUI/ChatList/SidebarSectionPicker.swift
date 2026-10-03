import SwiftUI

extension EnvironmentValues {
  /**
   Whether the chat list draws the section picker itself. On iPhone and iPad the picker is part of
   the list's content, below the large title, so a pull moves the title and the picker down together
   (a pinned bar would stay put while the title slid underneath it). The sidebar sets this; a chat
   list shown on its own, and the Mac's sidebar, leave it off and the sidebar pins the picker.
   */
  @Entry var chatListHostsSectionPicker = false
}

/// The Chats / Activity / Crons picker, bound to the router's section.
struct SidebarSectionPicker: View {
  @Environment(AppRouter.self) private var router

  var body: some View {
    @Bindable var router = router

    Picker(Strings.App.Tabs.chats, selection: $router.section) {
      Text(Strings.App.Tabs.chats).tag(SidebarSection.chats)
      Text(Strings.App.Tabs.activity).tag(SidebarSection.activity)
      Text(Strings.App.Tabs.routines).tag(SidebarSection.routines)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .accessibilityIdentifier("hermie.sidebar.sections")
  }
}

/// The picker as a bar above content that does not scroll (an empty state, a spinner, another
/// section's placeholder): there is no title sliding under it there, so pinning it is safe.
struct PinnedSectionPicker: ViewModifier {
  var isOn = true

  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .top, spacing: 0) {
      if isOn {
        SidebarSectionPicker()
          .padding(.horizontal)
          .padding(.vertical, 8)
      }
    }
  }
}

/// Pins the picker above a non-scrolling chat-list state when the sidebar asked the list to host it.
struct HostedPinnedSectionPicker: ViewModifier {
  @Environment(\.chatListHostsSectionPicker) private var hosts
  @Environment(AppRouter.self) private var router: AppRouter?

  func body(content: Content) -> some View {
    content.modifier(PinnedSectionPicker(isOn: hosts && router != nil))
  }
}

extension View {
  func hostedPinnedSectionPicker() -> some View {
    modifier(HostedPinnedSectionPicker())
  }
}
