import HermieCore
import SwiftUI

/**
 The one-time question before anything is stored in iCloud Keychain (ADR-0032, I10): what is
 stored, what never is, where it lives, and the two answers. Shown by the main window when the
 model says it is due (sync on and usable, not answered, something to store or to take) and by
 Settings → iCloud Sync when the switch is turned on unanswered. The engine writes nothing to iCloud
 until `acceptDisclosure()`; "Keep on This Device" turns sync off here.
 */
struct ICloudSyncDisclosure: View {
  @Environment(AppLaunch.self) private var launch

  var body: some View {
    let model = launch.iCloudSync
    let gateways = launch.gateways.entries
    let available = model.available

    NavigationStack {
      Form {
        Section {
          Label {
            Text(NativeStrings.ICloud.Disclosure.intro)
              .fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "icloud")
              .foregroundStyle(.tint)
              .accessibilityHidden(true)
          }
        }

        Section {
          DisclosureLine(NativeStrings.ICloud.Disclosure.storedList, systemImage: "list.bullet")
          DisclosureLine(NativeStrings.ICloud.Disclosure.storedSecrets, systemImage: "key")
        } header: {
          SettingsNote(NativeStrings.ICloud.Disclosure.storedHeader)
        }

        if !gateways.isEmpty {
          Section {
            ForEach(gateways) { entry in
              DisclosureGateway(name: entry.name, address: entry.address)
            }
          } header: {
            SettingsNote(NativeStrings.ICloud.Disclosure.gatewaysHeader)
          }
        }

        if !available.isEmpty {
          Section {
            ForEach(available) { offer in
              DisclosureGateway(name: offer.name, address: offer.address)
            }
          } header: {
            SettingsNote(NativeStrings.ICloud.Disclosure.availableHeader)
          }
        }

        Section {
          DisclosureLine(NativeStrings.ICloud.Disclosure.neverSignIns, systemImage: "person.badge.key")
          DisclosureLine(NativeStrings.ICloud.Disclosure.neverOther, systemImage: "lock")
        } header: {
          SettingsNote(NativeStrings.ICloud.Disclosure.neverHeader)
        }

        Section {
          DisclosureLine(NativeStrings.ICloud.Disclosure.whereBody, systemImage: "lock.icloud")
          DisclosureLine(NativeStrings.ICloud.Disclosure.whereOff, systemImage: "info.circle")
        } header: {
          SettingsNote(NativeStrings.ICloud.Disclosure.whereHeader)
        } footer: {
          SettingsNote(NativeStrings.ICloud.Disclosure.later)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.ICloud.Disclosure.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .safeAreaInset(edge: .bottom, spacing: 0) {
        DisclosureAnswers(model: model)
      }
    }
    .interactiveDismissDisabled()
    // The full page on iPad, as Settings is: a form sheet leaves the dimmed window beside it, which
    // the contrast audit reads as text.
    .presentationSizing(.page)
    #if os(macOS)
      .frame(minWidth: 460, idealWidth: 520, minHeight: 560, idealHeight: 640)
    #endif
    .accessibilityIdentifier("hermie.icloud.disclosure")
  }
}

/// The two answers, pinned under the text. Return answers "Sync with iCloud", Escape the other.
private struct DisclosureAnswers: View {
  let model: ICloudSyncModel

  var body: some View {
    VStack(spacing: 8) {
      Button {
        Task { await model.acceptDisclosure() }
      } label: {
        Text(NativeStrings.ICloud.Disclosure.accept)
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .keyboardShortcut(.defaultAction)
      .accessibilityIdentifier("hermie.icloud.disclosure.accept")

      Button {
        Task { await model.declineDisclosure() }
      } label: {
        Text(NativeStrings.ICloud.Disclosure.decline)
          .frame(maxWidth: .infinity)
      }
      // Borderless: a tinted fill under tinted text fails the contrast audit.
      .buttonStyle(.borderless)
      .controlSize(.large)
      .keyboardShortcut(.cancelAction)
      .accessibilityIdentifier("hermie.icloud.disclosure.decline")
    }
    .disabled(model.busy)
    .padding()
    // Opaque: over a translucent bar the second answer's tint misses the contrast audit.
    .background(.background)
  }
}

private struct DisclosureLine: View {
  let text: String
  let systemImage: String

  init(_ text: String, systemImage: String) {
    self.text = text
    self.systemImage = systemImage
  }

  var body: some View {
    Label {
      Text(text)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: systemImage)
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
    }
  }
}

private struct DisclosureGateway: View {
  let name: String
  let address: String

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(name)
      Text(address)
        .font(.footnote)
    }
    .accessibilityElement(children: .combine)
  }
}

/// Presents `ICloudSyncDisclosure` over the main window when it is due and no other sheet is up.
struct ICloudSyncDisclosurePresenter: ViewModifier {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router

  func body(content: Content) -> some View {
    let model = launch.iCloudSync

    content
      .sheet(
        isPresented: Binding(
          get: { model.needsDisclosure && router.sheet == nil },
          // Only an answer closes it (dismissing interactively is turned off).
          set: { _ in }
        )
      ) {
        ICloudSyncDisclosure()
      }
  }
}

extension View {
  /// See `ICloudSyncDisclosurePresenter`.
  func iCloudSyncDisclosure() -> some View {
    modifier(ICloudSyncDisclosurePresenter())
  }
}
