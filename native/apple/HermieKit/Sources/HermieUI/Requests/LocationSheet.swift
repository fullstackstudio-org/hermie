import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for a `device.location` (`contract/requests/README.md` §9): where the device is, once.
///
/// It says what would be shared and at which precision, lets the person choose less than was asked
/// (never more), and only when they press Share does the system's own permission question come, then
/// one reading. A refused permission, or no position, is told to the bot (`4041 permission_denied`,
/// `location_unavailable`) and left as a notice on the chat.
struct LocationSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt

  @State private var location: InteractiveLocationModel
  @State private var armed = false
  @State private var sharing: Task<Void, Never>?

  init(
    model: InteractiveModel, prompt: InteractivePrompt, request: DeviceLocationRequest,
    provider: any DeviceLocationProvider = SystemLocationProvider.shared
  ) {
    self.model = model
    self.prompt = prompt
    _location = State(initialValue: InteractiveLocationModel(request: request, provider: provider))
  }

  private var busy: Bool {
    location.isLocating || model.isSending
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "location.fill",
      title: NativeStrings.Interactive.titleLocation(model.botName),
      busy: busy
    ) {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 8) {
          Text(NativeStrings.Interactive.Location.heading)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
          Label {
            VStack(alignment: .leading, spacing: 2) {
              Text(NativeStrings.Interactive.Location.shares(location.precision))
                .font(.headline)
              Text(NativeStrings.Interactive.Location.detail(location.precision))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          } icon: {
            Image(systemName: location.precision == .precise ? "location.fill" : "location.circle")
              .foregroundStyle(.tint)
              .accessibilityHidden(true)
          }
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(.background.secondary, in: .rect(cornerRadius: 12))
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("location.shares")
        }

        if location.canChoosePrecision {
          VStack(alignment: .leading, spacing: 6) {
            Picker(
              NativeStrings.Interactive.Location.precisionLabel,
              selection: Binding(get: { location.precision }, set: { location.choose($0) })
            ) {
              Text(NativeStrings.Interactive.Location.optionPrecise).tag(LocationPrecision.precise)
              Text(NativeStrings.Interactive.Location.optionApproximate).tag(LocationPrecision.approximate)
            }
            .pickerStyle(.segmented)
            .disabled(busy)
            .accessibilityIdentifier("location.precision")
            Text(NativeStrings.Interactive.Location.lowerNote)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        VStack(alignment: .leading, spacing: 6) {
          Text(NativeStrings.Interactive.Location.oneFix)
          Text(NativeStrings.Interactive.Location.permissionNote)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

        if location.isLocating {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text(NativeStrings.Interactive.Location.locating)
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("location.locating")
        }
      }
      .disabled(model.isSending)
    } actions: {
      VStack(spacing: 6) {
        InteractiveButtonRow {
          LaterButton(model: model)

          if prompt.offersSkip {
            SkipButton(model: model, armed: armed, disabled: location.isLocating)
          }

          shareButton
        }
        DeclineButton(model: model, armed: armed && !location.isLocating)
      }
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    // The system's question is up while the fix is taken: an approval waits rather than cutting it off.
    .onChange(of: location.isLocating) { _, locating in
      model.setWorking(locating)
    }
    .onDisappear {
      sharing?.cancel()
      model.setWorking(false)
    }
  }

  private var shareButton: some View {
    Button {
      share()
    } label: {
      Text(model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.Location.share)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || busy)
    .accessibilityHint(NativeStrings.Interactive.Location.shareHint)
    .accessibilityIdentifier(model.hasFailed ? "interactive.retry" : "location.share")
  }

  /// The person pressed Share: only now is the system asked.
  private func share() {
    guard armed, !busy else {
      return
    }

    let location = self.location
    let model = self.model

    sharing = Task {
      guard let step = await location.share() else {
        return
      }

      await model.perform(step)
    }
  }
}
