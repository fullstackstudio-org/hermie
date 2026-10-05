#if os(macOS)
  import AppKit
  import HermieCore
  import SwiftUI

  extension HotKeyShortcut {
    /// The shortcut a key press is, from the key's code and the modifier keys held: Shift, Control,
    /// Option and Command count; Caps Lock, Fn and the numeric pad's flag do not.
    init(keyCode: UInt16, flags: NSEvent.ModifierFlags) {
      var modifiers: Modifiers = []

      if flags.contains(.command) { modifiers.insert(.command) }
      if flags.contains(.option) { modifiers.insert(.option) }
      if flags.contains(.control) { modifiers.insert(.control) }
      if flags.contains(.shift) { modifiers.insert(.shift) }

      self.init(keyCode: keyCode, modifiers: modifiers)
    }
  }

  /// What a key press does while the shortcut field is recording.
  enum ShortcutRecording: Equatable {
    /// Escape: stop recording, change nothing.
    case cancel
    /// Delete with no modifier: no shortcut.
    case clear
    /// A shortcut was pressed.
    case choose(HotKeyShortcut)

    static func of(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> ShortcutRecording {
      let held = flags.intersection([.command, .option, .control, .shift])

      if held.isEmpty {
        switch keyCode {
        case 53: return .cancel
        case 51, 117: return .clear
        default: break
        }
      }

      return .choose(HotKeyShortcut(keyCode: keyCode, flags: held))
    }
  }

  /**
   Settings, General: the Mac's own behaviour. For now the quick ask: its menu bar item and the global
   shortcut that opens it from any app.
   */
  struct GeneralSettingsPage: View {
    @Environment(\.quickAsk) private var system

    var body: some View {
      Form {
        if let system {
          QuickAskSettingsSections(settings: system.settings, hotKey: system.hotKey)
        }
      }
      .formStyle(.grouped)
    }
  }

  /// The quick ask's two sections: the switch for the menu bar item, and the shortcut.
  struct QuickAskSettingsSections: View {
    let settings: QuickAskSettings
    let hotKey: GlobalHotKeyController

    @State private var recording = false
    @State private var refused = false

    var body: some View {
      Section {
        Toggle(
          NativeStrings.General.showInMenuBar,
          isOn: Binding(get: { settings.showInMenuBar }, set: { settings.setShowInMenuBar($0) })
        )
        .accessibilityIdentifier("hermie.settings.general.menuBar")
      } header: {
        Text(NativeStrings.General.quickAsk)
      } footer: {
        SettingsNote(NativeStrings.General.showInMenuBarFooter)
      }

      Section {
        LabeledContent(NativeStrings.General.shortcut) {
          HStack(spacing: 8) {
            ShortcutField(
              shortcut: settings.hotKey, recording: $recording,
              onCapture: { capture($0) }
            )

            if settings.hotKey != .standard, !recording {
              Button(NativeStrings.General.shortcutReset) {
                hotKey.choose(.standard)
              }
              .buttonStyle(.borderless)
            }
          }
        }
      } footer: {
        VStack(alignment: .leading, spacing: 4) {
          if recording {
            SettingsNote(NativeStrings.General.shortcutRecordingHint)
          }

          if refused {
            SettingsNote(NativeStrings.General.shortcutRefused)
          }

          statusNote

          SettingsNote(NativeStrings.General.shortcutFooter)
        }
      }
      // The shortcut being recorded must reach the field, not the shortcut that is registered now.
      .onChange(of: recording) { _, recording in
        if recording {
          hotKey.suspend()
          refused = false
        } else {
          hotKey.apply()
        }
      }
    }

    /// How the registered shortcut stands: working, or refused by the system and why.
    @ViewBuilder private var statusNote: some View {
      switch hotKey.status {
      case .off:
        EmptyView()
      case .active(let shortcut):
        SettingsNote(NativeStrings.General.shortcutActive(shortcut.display))
      case .unavailable(let shortcut, .taken):
        Text(NativeStrings.General.shortcutTaken(shortcut.display))
          .foregroundStyle(.red)
      case .unavailable(let shortcut, .failed):
        Text(NativeStrings.General.shortcutFailed(shortcut.display))
          .foregroundStyle(.red)
      }
    }

    /// A key press while recording. True when recording is over.
    private func capture(_ result: ShortcutRecording) -> Bool {
      switch result {
      case .cancel:
        return true
      case .clear:
        settings.setHotKey(nil)
        return true
      case .choose(let shortcut):
        guard shortcut.isValid else {
          refused = true
          return false
        }

        settings.setHotKey(shortcut)
        return true
      }
    }
  }

  /**
   The shortcut as a field: it shows the shortcut, and while it records, the next key combination
   pressed is the new one. The keys are read by a monitor of this app's own key events, which needs
   no permission and sees nothing outside the app.
   */
  struct ShortcutField: View {
    let shortcut: HotKeyShortcut?
    @Binding var recording: Bool
    /// Told what a key press was while recording; true ends the recording.
    let onCapture: (ShortcutRecording) -> Bool

    @State private var monitor: Any?

    var body: some View {
      Button {
        recording.toggle()
      } label: {
        Text(label)
          .monospacedDigit()
          .frame(minWidth: 96)
      }
      .buttonStyle(.bordered)
      .accessibilityLabel(NativeStrings.General.shortcut)
      .accessibilityValue(label)
      .accessibilityHint(NativeStrings.General.shortcutHint)
      .accessibilityIdentifier("hermie.settings.general.shortcut")
      .onChange(of: recording) { _, recording in
        recording ? startMonitor() : stopMonitor()
      }
      .onDisappear {
        stopMonitor()
        recording = false
      }
    }

    private var label: String {
      if recording {
        return NativeStrings.General.shortcutRecording
      }

      return shortcut?.display ?? NativeStrings.General.shortcutNone
    }

    private func startMonitor() {
      guard monitor == nil else {
        return
      }

      monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
        if onCapture(ShortcutRecording.of(keyCode: event.keyCode, flags: event.modifierFlags)) {
          recording = false
        }

        // Swallowed: a key pressed to record is not typed anywhere.
        return nil
      }
    }

    private func stopMonitor() {
      if let monitor {
        NSEvent.removeMonitor(monitor)
      }

      monitor = nil
    }
  }
#endif
