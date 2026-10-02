import HermieCore
import SwiftUI

extension LockThreshold {
  var label: String {
    switch self {
    case .off: Strings.App.Settings.Lock.Options.off
    case .immediately: Strings.App.Settings.Lock.Options.immediately
    case .oneMinute: Strings.App.Settings.Lock.Options._1m
    case .fiveMinutes: Strings.App.Settings.Lock.Options._5m
    case .fifteenMinutes: Strings.App.Settings.Lock.Options._15m
    }
  }
}

/// Privacy & security: the app lock row.
struct PrivacySettingsPage: View {
  @Environment(AppLaunch.self) private var launch

  var body: some View {
    let lock = launch.lock

    Form {
      Section {
        NavigationLink {
          LockThresholdPage()
        } label: {
          LabeledContent(Strings.App.Settings.Lock.label) {
            Text(lock.settingUnknown ? Strings.App.Settings.unknown : lock.machine.threshold.label)
          }
        }
        .accessibilityIdentifier("hermie.settings.lock")
      } footer: {
        SettingsNote(SettingsCategory.privacy.blurb)
      }
    }
    .formStyle(.grouped)
  }
}

/**
 Privacy & security → Require unlock, as a list to pick from (HERM-106).

 Every pick, Off included, authenticates before it takes (`AppLock.changeThreshold`); this page
 only decides what to show while that is out and afterwards. Picking the value already in force is
 not a change and costs no prompt.
 */
struct LockThresholdPage: View {
  /// Why a pick did not take.
  enum Refusal: Equatable {
    case noEnrolment(DeviceEnrolment)
    case refused
  }

  @Environment(AppLaunch.self) private var launch
  @Environment(\.dismiss) private var dismiss
  @State private var refusal: Refusal?
  @State private var pending = false

  var body: some View {
    let lock = launch.lock

    Form {
      Section {
        ForEach(LockThreshold.allCases, id: \.self) { threshold in
          let chosen = !lock.settingUnknown && threshold == lock.machine.threshold

          Button {
            pick(threshold)
          } label: {
            HStack {
              Text(threshold.label)
                .foregroundStyle(.primary)
              Spacer()
              if chosen {
                Image(systemName: "checkmark")
                  .foregroundStyle(.tint)
                  .accessibilityHidden(true)
              }
            }
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(chosen ? .isSelected : [])
          .accessibilityIdentifier("hermie.lock.option.\(threshold.rawValue)")
        }
      } footer: {
        SettingsNote(Self.footer(refusal: refusal, lock: lock))
          .accessibilityIdentifier("hermie.lock.footer")
      }
    }
    .formStyle(.grouped)
    .disabled(pending)
    .navigationTitle(Strings.App.Settings.Lock.label)
    .task {
      await lock.checkEnrolment()
    }
  }

  private func pick(_ threshold: LockThreshold) {
    let lock = launch.lock

    guard !pending else {
      return
    }

    refusal = nil
    pending = true

    Task {
      let outcome = await lock.changeThreshold(threshold, reason: Strings.App.Lock.prompt)

      pending = false

      switch outcome {
      case .changed, .unchanged:
        dismiss()
      case let .noEnrolment(enrolment):
        refusal = .noEnrolment(enrolment)
      case .refused, .busy:
        refusal = .refused
      }
    }
  }

  /// Why the row still shows the old value, or, absent a refusal, what the current one means.
  static func footer(refusal: Refusal?, lock: AppLock) -> String {
    switch refusal {
    case .noEnrolment(.unavailable):
      return Strings.App.Settings.Lock.unavailable
    case .noEnrolment:
      return Strings.App.Settings.Lock.noEnrolment
    case .refused:
      return Strings.App.Settings.Lock.refused
    case nil:
      if lock.settingUnknown {
        return NativeStrings.Lock.settingUnknown
      }

      if lock.enrolment == .passcode {
        return Strings.App.Settings.Lock.passcodeOnly
      }

      return lock.machine.threshold == .off ? Strings.App.Settings.Lock.hint : Strings.App.Settings.Lock.hintOn
    }
  }
}
