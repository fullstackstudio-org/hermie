import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// Carry out what a router transition asked for.
@MainActor
func perform(_ effects: [RouterEffect], on launch: AppLaunch) {
  for effect in effects {
    switch effect {
    case let .activateGateway(id):
      Task {
        try? await launch.gateways.activate(id: id)
      }
    }
  }
}

extension GatewayDirectory {
  /// What the router needs to know, or nil before the registry has been read.
  var routerIndex: GatewayIndex? {
    guard loaded else {
      return nil
    }

    return GatewayIndex(entries: entries.map { GatewayIndex.Entry(id: $0.id, key: $0.key) }, activeId: activeId)
  }
}

/// The toolbar's gateway menu: the configured gateways, the live one checked, and setup for another.
struct GatewaySwitcherMenu: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router
  /// Read so the menu is rebuilt, and its titles fitted again, when the text size changes.
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let directory = launch.gateways

    Menu {
      Section(Strings.App.Settings.Gateways.title) {
        ForEach(directory.entries) { entry in
          Toggle(
            isOn: Binding(
              get: { entry.id == router.selectedGatewayId },
              set: { on in
                if on { perform(router.switchGateway(to: entry.id), on: launch) }
              }
            )
          ) {
            // A gateway is usually named after its host: one line, cut in the middle, never
            // hyphenated across two. The whole name (and the address) is what VoiceOver reads.
            Text(MenuTitle.fitted(entry.name, typeSize: typeSize))
              .lineLimit(1)
              .truncationMode(.middle)
          }
          .accessibilityLabel(entry.name == entry.address ? entry.name : "\(entry.name), \(entry.address)")
        }
      }

      Divider()

      // No icon: the toggles above reserve the checkmark column, and an icon beside it would take
      // a second column from the words (the system menu is about 250 pt wide on a phone), which
      // broke "Gateway toevoegen" over two lines.
      Button(Strings.App.Settings.Gateways.add) {
        router.present(.onboarding(.additionalGateway))
      }
      .accessibilityIdentifier("hermie.toolbar.gateways.add")
    } label: {
      Label(Strings.App.Settings.Gateways.title, systemImage: "server.rack")
    }
    .accessibilityValue(directory.entry(id: router.selectedGatewayId)?.name ?? "")
    .accessibilityIdentifier("hermie.toolbar.gateways")
  }
}

/**
 A title for one row of a system menu, cut in the middle to one line.

 A phone's menu ignores `lineLimit` and `truncationMode`: it wraps a long title over two lines and
 hyphenates it, which turns a host name into "hermes.fullstackstu-" over "dio.nl". So the title is
 cut before it reaches the menu, measured in the menu's own font (the body style at the reader's
 text size) against the room a row has beside the checkmark column. The menu stays about 250 pt
 wide at every standard text size; measured on iOS 26, its words get about 155 pt, so 150 leaves a
 margin. The Mac's menus grow to fit their titles and need none of this.
 */
enum MenuTitle {
  static let width: CGFloat = 150

  static func fitted(_ title: String, typeSize: DynamicTypeSize) -> String {
    #if os(iOS)
      let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
      let font = UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits)

      return middleTruncated(title) { candidate in
        (candidate as NSString).size(withAttributes: [.font: font]).width <= width
      }
    #else
      return title
    #endif
  }

  /// The longest `head…tail` of `title` that `fits`, keeping a little more of the head; the title
  /// itself when it fits whole.
  static func middleTruncated(_ title: String, fits: (String) -> Bool) -> String {
    guard !fits(title) else {
      return title
    }

    let characters = Array(title)
    var low = 0
    var high = characters.count - 1
    var best = "…"

    while low <= high {
      let keep = (low + high) / 2
      let head = (keep + 1) / 2
      let candidate = String(characters.prefix(head)) + "…" + String(characters.suffix(keep - head))

      if fits(candidate) {
        best = candidate
        low = keep + 1
      } else {
        high = keep - 1
      }
    }

    return best
  }
}

/// The gateway picker the Switch Gateway command opens.
struct GatewayPickerSheet: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router

  var body: some View {
    NavigationStack {
      List(launch.gateways.entries) { entry in
        Button {
          perform(router.switchGateway(to: entry.id), on: launch)
        } label: {
          GatewayRowLabel(entry: entry, active: entry.id == router.selectedGatewayId)
        }
        .accessibilityAddTraits(entry.id == router.selectedGatewayId ? .isSelected : [])
      }
      .navigationTitle(Strings.App.Settings.Gateways.title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) { router.dismissSheet() }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 360, minHeight: 280)
    #endif
  }
}

/// One gateway as a row: its name, its address, and whether it is the live one. `note` is an
/// optional third line (Settings puts the gateway's iCloud Sync state there).
struct GatewayRowLabel: View {
  let entry: GatewayDirectory.Entry
  let active: Bool
  var note: Text?

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(entry.name)
          .font(.body.weight(.semibold))
        Text(entry.address)
          .font(.footnote)
        if let note {
          note
            .font(.footnote)
        }
      }

      Spacer()

      if active {
        Text(Strings.App.Settings.Gateways.active)
          .font(.footnote)
        Image(systemName: "checkmark")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
  }
}
