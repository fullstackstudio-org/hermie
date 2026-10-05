import HermieCore
import SwiftUI

extension NeedsYouCopy {
  /// What a row is titled with, in the reader's language.
  static var localized: NeedsYouCopy {
    NeedsYouCopy(
      request: .localized,
      connector: NativeStrings.NeedsYou.connectorTitle,
      other: RequestAlertCopy.localized.attention
    )
  }
}

extension NeedsYouKind {
  /// The symbol a row of this kind carries.
  var symbol: String {
    switch self {
    case .approval: "checkmark.shield"
    case .question: "questionmark.bubble"
    case .secureInput: "lock"
    case .confirmation: "checkmark.seal"
    case .input: "square.and.pencil"
    case .review: "doc.text.magnifyingglass"
    case .device: "iphone"
    case .connector: "link"
    case .other: "bell"
    }
  }
}

/**
 The "Needs you" inbox as a sheet (`AppSheet.needsYou`): one list of everything waiting for the
 person, across bots. A tap on a row opens that bot's chat with the request's sheet up.
 */
struct NeedsYouSheet: View {
  @Environment(\.liveWiring) private var wiring
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      if let inbox = wiring?.inbox {
        NeedsYouScreen(inbox: inbox)
      } else {
        EmptyState(
          NativeStrings.NeedsYou.emptyTitle,
          systemImage: "tray",
          message: Text(NativeStrings.NeedsYou.emptyMessage)
        ) {
          Button(Strings.App.Common.done) { dismiss() }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 480, minHeight: 440)
    #endif
    .accessibilityIdentifier("hermie.needsYou")
  }
}

/// The list over one inbox.
struct NeedsYouScreen: View {
  let inbox: NeedsYouInbox

  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(\.liveWiring) private var wiring
  @Environment(\.dismiss) private var dismiss
  @State private var stopping = false

  var body: some View {
    let items = inbox.items

    Group {
      if items.isEmpty {
        EmptyState(
          NativeStrings.NeedsYou.emptyTitle,
          systemImage: "tray",
          message: Text(NativeStrings.NeedsYou.emptyMessage)
        )
        .accessibilityIdentifier("hermie.needsYou.empty")
      } else {
        list(items)
      }
    }
    .navigationTitle(NativeStrings.NeedsYou.title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(Strings.App.Common.done) { dismiss() }
          .keyboardShortcut(.cancelAction)
      }

      ToolbarItem(placement: .primaryAction) {
        Button(role: .destructive) {
          stopping = true
        } label: {
          Label(NativeStrings.EmergencyStop.button, systemImage: "stop.circle")
        }
        .accessibilityIdentifier("hermie.needsYou.stopAll")
      }
    }
    .sheet(isPresented: $stopping) {
      EmergencyStopSheet()
    }
  }

  private func list(_ items: [NeedsYouItem]) -> some View {
    let copy = NeedsYouCopy.localized
    let showsGateway = launch.gateways.entries.count > 1

    return List {
      Section {
        ForEach(items) { item in
          NeedsYouRow(item: item, title: item.title(copy: copy), showsGateway: showsGateway) {
            open(item)
          }
        }
      } header: {
        Text(NativeStrings.NeedsYou.count(items.count))
      } footer: {
        if showsGateway {
          Text(NativeStrings.NeedsYou.otherGateways)
        }
      }
    }
    .accessibilityIdentifier("hermie.needsYou.list")
  }

  private func open(_ item: NeedsYouItem) {
    guard let router else {
      return
    }

    NeedsYouOpening.open(
      item, in: router,
      bringBack: { key, bot, id in wiring?.bringBack(gatewayKey: key, bot: bot, requestId: id) },
      activate: { perform($0, on: launch) }
    )
  }
}

/// One thing that waits: the bot, what it wants, and how long it has waited.
struct NeedsYouRow: View {
  let item: NeedsYouItem
  let title: String
  let showsGateway: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: item.kind.symbol)
          .font(.title3)
          .foregroundStyle(.tint)
          .frame(width: 28)
          .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 2) {
          Text(item.displayBot)
            .font(.headline)

          Text(title)
            .font(.subheadline)
            .lineLimit(2)

          caption
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Spacer(minLength: 0)

        Image(systemName: "chevron.right")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityHint(NativeStrings.NeedsYou.rowHint)
    .accessibilityIdentifier("hermie.needsYou.row")
  }

  /// "Approval · Home server" and under it "Waiting 3 min", which keeps counting by itself.
  private var caption: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(verbatim: kindLine)

      HStack(spacing: 4) {
        Text(NativeStrings.NeedsYou.waiting)
        Text(item.since, style: .relative)
      }
    }
  }

  private var kindLine: String {
    let kind = NativeStrings.NeedsYou.kind(item.kind)

    return showsGateway && !item.gatewayName.isEmpty ? "\(kind) · \(item.gatewayName)" : kind
  }
}

/**
 The toolbar item that opens the list, with the number of things waiting on it. Hidden where the app
 has no inbox (a preview, a test launch).
 */
struct NeedsYouButton: View {
  @Environment(\.liveWiring) private var wiring
  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    if let inbox = wiring?.inbox {
      let count = inbox.count

      Button {
        router?.present(.needsYou)
      } label: {
        Image(systemName: count > 0 ? "tray.full" : "tray")
          .overlay(alignment: .topTrailing) {
            if count > 0 {
              Text(verbatim: count > 99 ? "99+" : "\(count)")
                .font(.system(size: 10, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .frame(minWidth: 14, minHeight: 14)
                .background(.red, in: Capsule())
                .offset(x: 8, y: -6)
            }
          }
      }
      .help(NativeStrings.NeedsYou.title)
      .accessibilityLabel(NativeStrings.NeedsYou.title)
      .accessibilityValue(count > 0 ? NativeStrings.NeedsYou.count(count) : "")
      .accessibilityIdentifier("hermie.toolbar.needsYou")
    }
  }
}
