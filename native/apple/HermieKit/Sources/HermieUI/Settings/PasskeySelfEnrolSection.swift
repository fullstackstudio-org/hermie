import HermieCore
import SwiftUI

/**
 "Add a passkey" on the Passkeys page: sign in again (step 1), then create the passkey (step 2), with
 the time the sign-in stays good for. It only draws a `PasskeysSelfEnrolState` and calls what the
 page gives it; the model's flow, the system sheets and the clock are the page's.

 Fixed words: the steps' titles, their one line each, the countdown and one sentence per reason are
 `PasskeysText`'s and the catalog's. Nothing the gateway or the identity provider wrote reaches the
 screen. VoiceOver reads each step as "Step 1 of 2: Sign in again" with its line, and the countdown
 by whole minutes so that it does not speak every second.
 */
struct PasskeySelfEnrolSection: View {
  let state: PasskeysSelfEnrolState
  let gatewayName: String
  /// The operator's waiting period for a passkey added this way, in a sentence, when there is one.
  let coolingOff: String?
  /// Something else on the page is running; no button here starts anything meanwhile.
  let busy: Bool
  let signIn: () -> Void
  let create: () -> Void
  let another: () -> Void

  var body: some View {
    Section {
      if let sentence = state.sentence(host: gatewayName) {
        sentenceRow(sentence)
      }

      if state.showsSteps {
        stepOne
        stepTwo
        countdown
        anotherRow
      }
    } header: {
      SettingsNote(NativeStrings.Passkeys.SelfEnrol.header)
    } footer: {
      if state.showsSteps {
        SettingsNote(footerText)
      }
    }
    .accessibilityIdentifier("hermie.passkeys.self")
  }

  private var footerText: String {
    [NativeStrings.Passkeys.SelfEnrol.footer, coolingOff].compactMap { $0 }.joined(separator: " ")
  }

  // MARK: Rows

  private func sentenceRow(_ sentence: String) -> some View {
    Label {
      Text(sentence)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: Self.symbol(state))
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.passkeys.self.sentence")
  }

  private var stepOne: some View {
    let title = NativeStrings.Passkeys.SelfEnrol.step1Title
    let detail: String =
      switch state.step1 {
      case .working: NativeStrings.Passkeys.SelfEnrol.step1Waiting
      case .done: NativeStrings.Passkeys.SelfEnrol.step1Done
      case .upcoming, .current: NativeStrings.Passkeys.SelfEnrol.step1Idle
      }

    return step(number: 1, progress: state.step1, title: title, detail: detail) {
      if state.canSignIn {
        Button(NativeStrings.Passkeys.SelfEnrol.signInAction, action: signIn)
          .disabled(busy)
          .accessibilityIdentifier("hermie.passkeys.self.signin")
      }
    }
  }

  private var stepTwo: some View {
    let title = NativeStrings.Passkeys.SelfEnrol.step2Title
    let detail: String =
      switch state.step2 {
      case .upcoming: NativeStrings.Passkeys.SelfEnrol.step2Locked
      case .current: NativeStrings.Passkeys.SelfEnrol.step2Ready
      case .working: NativeStrings.Passkeys.SelfEnrol.step2Waiting
      case .done: NativeStrings.Passkeys.SelfEnrol.step2Done
      }

    return step(number: 2, progress: state.step2, title: title, detail: detail) {
      if state.canCreate {
        Button(NativeStrings.Passkeys.SelfEnrol.createAction, action: create)
          .disabled(busy)
          .accessibilityIdentifier("hermie.passkeys.self.create")
      }
    }
  }

  private func step<Action: View>(
    number: Int,
    progress: PasskeysSelfEnrolState.Step,
    title: String,
    detail: String,
    @ViewBuilder action: () -> Action
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        marker(number: number, progress: progress)

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body)
            .foregroundStyle(progress == .upcoming ? Color.secondary : Color.primary)
          Text(detail)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(verbatim: PasskeysText.stepLabel(number, title: title)))
      .accessibilityValue(Text(verbatim: detail))
      .accessibilityIdentifier("hermie.passkeys.self.step\(number)")

      action()
    }
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func marker(number: Int, progress: PasskeysSelfEnrolState.Step) -> some View {
    switch progress {
    case .done:
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
    case .working:
      ProgressView()
        .controlSize(.small)
        .accessibilityHidden(true)
    case .current:
      Image(systemName: "\(number).circle")
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
    case .upcoming:
      Image(systemName: "\(number).circle")
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
  }

  @ViewBuilder private var countdown: some View {
    if let seconds = state.secondsLeft {
      Text(PasskeysText.timeLeft(seconds: seconds))
        .font(.footnote.monospacedDigit())
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: NativeStrings.Passkeys.SelfEnrol.timeLeftLabel))
        .accessibilityValue(Text(verbatim: PasskeysText.timeLeftSpoken(seconds: seconds)))
        .accessibilityIdentifier("hermie.passkeys.self.countdown")
    }
  }

  @ViewBuilder private var anotherRow: some View {
    if state == .done {
      Button(NativeStrings.Passkeys.SelfEnrol.anotherAction, action: another)
        .disabled(busy)
        .accessibilityIdentifier("hermie.passkeys.self.another")
    }
  }

  static func symbol(_ state: PasskeysSelfEnrolState) -> String {
    switch state {
    case .unavailable: "nosign"
    case .expired: "clock.badge.exclamationmark"
    default: "exclamationmark.triangle"
    }
  }
}
