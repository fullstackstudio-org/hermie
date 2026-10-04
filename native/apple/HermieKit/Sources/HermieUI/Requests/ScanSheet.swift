import HermieCore
import HermieProtocol
import SwiftUI

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// The sheet for a `device.scan`: the person presses Scan, the camera turns on (and the system asks for it, the
/// first time), the first code of a kind the request asks for is read, and what it says is SHOWN, as plain text, before
/// anything is sent. Send answers with it; Scan again looks for another; Skip or Don't share refuse.
///
/// A code is untrusted text. The sheet says so, shows it cleaned the way the gateway cleans it (`ScanValue`), and
/// never opens it: no link is followed, no app is launched.
struct ScanSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let request: ScanRequest

  @State private var scan: InteractiveScanModel
  @State private var armed = false
  @Environment(\.scenePhase) private var scenePhase

  init(model: InteractiveModel, prompt: InteractivePrompt, request: ScanRequest) {
    self.model = model
    self.prompt = prompt
    self.request = request
    _scan = State(initialValue: InteractiveScanModel(request: request))
  }

  private typealias Words = NativeStrings.DeviceRequests.Scan

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "qrcode.viewfinder",
      title: Words.title(model.botName),
      busy: model.isSending
    ) {
      VStack(alignment: .leading, spacing: 16) {
        Text(verbatim: kindsLine)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("scan.kinds")

        switch scan.phase {
        case .ready:
          Text(Words.intro)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("scan.intro")
        case .asking:
          ProgressView()
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("scan.asking")
        case .scanning:
          scanner
        case .found(let found):
          foundView(found)
        case .unavailable(let reason):
          unavailableView(reason)
        }
      }
      .disabled(model.isSending)
    } actions: {
      actions
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    // The camera goes off when the app is not in front, and when the sheet goes.
    .onChange(of: scenePhase) { _, phase in
      if phase != .active {
        scan.pause()
      }
    }
    .onChange(of: scan.found) { _, found in
      if found != nil {
        AccessibilityNotification.Announcement(Words.found).post()
      }
    }
    .onDisappear {
      scan.pause()
    }
  }

  // MARK: Pieces

  /// "Looking for: QR code, Aztec code", or "any code".
  private var kindsLine: String {
    let kinds = request.formats.isEmpty ? Words.anyCode : request.formats.map(Words.name).joined(separator: ", ")
    return Words.looking(kinds)
  }

  private var scanner: some View {
    VStack(alignment: .leading, spacing: 8) {
      CodeScannerView(
        symbologies: scan.symbologies,
        onCode: { value, symbology in scan.detected(value, as: symbology) },
        onFailure: { scan.scannerFailed() }
      )
      .frame(height: 320)
      .clipShape(.rect(cornerRadius: 12))
      .accessibilityLabel(Words.cameraLabel)
      .accessibilityIdentifier("scan.camera")

      Text(Words.aim)
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("scan.aim")
    }
  }

  private func foundView(_ found: InteractiveScanModel.Found) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(Words.found, systemImage: "checkmark.circle.fill")
        .font(.headline)
        .foregroundStyle(.green)
        .accessibilityAddTraits(.isHeader)
      Text(Words.kind(Words.name(found.symbology)))
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("scan.kind")

      VStack(alignment: .leading, spacing: 6) {
        Text(Words.valueLabel)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        // What the code says: plain text, monospaced where whitespace matters, never a link.
        RequestTextBox(text: found.preview, identifier: "scan.value", monospaced: true)
      }

      if let problem = found.problem {
        Label(problemText(problem), systemImage: "exclamationmark.triangle")
          .font(.callout)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("scan.problem")
      } else {
        Label(Words.untrusted, systemImage: "exclamationmark.shield")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("scan.untrusted")
      }

      if found.wasCleaned {
        Label(Words.cleaned, systemImage: "eye.slash")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("scan.cleaned")
      }
    }
  }

  private func problemText(_ problem: ScanValue.Problem) -> String {
    switch problem {
    case .empty: Words.empty
    case .tooLong: Words.tooLong
    }
  }

  private func unavailableView(_ reason: InteractiveScanModel.Unavailable) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(unavailableText(reason), systemImage: "camera.metering.unknown")
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("scan.unavailable")

      if reason == .denied {
        Button(NativeStrings.DeviceRequests.openSettings) {
          SystemSettings.open(.camera)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("scan.openSettings")
      }
    }
  }

  private func unavailableText(_ reason: InteractiveScanModel.Unavailable) -> String {
    switch reason {
    case .denied: Words.denied
    case .restricted: Words.restricted
    case .noCamera: Words.noCamera
    }
  }

  // MARK: Actions

  @ViewBuilder private var actions: some View {
    VStack(spacing: 6) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) { buttons(mainLast: true) }
        VStack(spacing: 10) { buttons(mainLast: false) }
      }

      if case .unavailable(let reason) = scan.phase {
        Button {
          Task { await model.cannotShow(reason: reason.reason) }
        } label: {
          Text(Words.cannot)
            .font(.callout)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .disabled(!armed || model.isSending)
        .accessibilityHint(Words.cannotHint)
        .accessibilityIdentifier("scan.cannot")
      }

      DeclineButton(model: model, armed: armed)
    }
  }

  @ViewBuilder private func buttons(mainLast: Bool) -> some View {
    if !mainLast {
      mainButton
    }

    LaterButton(model: model)

    if prompt.offersSkip {
      SkipButton(model: model, armed: armed)
    }

    if scan.found != nil {
      Button {
        scan.rescan()
      } label: {
        Text(Words.rescan)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .disabled(model.isSending)
      .accessibilityIdentifier("scan.rescan")
    }

    if mainLast {
      mainButton
    }
  }

  /// Scan before a code is read, Send once one is.
  @ViewBuilder private var mainButton: some View {
    switch scan.phase {
    case .found:
      Button {
        send()
      } label: {
        Text(model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.send)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!armed || model.isSending || scan.answer == nil)
      .accessibilityIdentifier("scan.send")
    case .ready, .unavailable:
      Button {
        Task { await scan.start() }
      } label: {
        Text(Words.start)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!armed || model.isSending || scan.unavailable == .noCamera || scan.unavailable == .restricted)
      .accessibilityIdentifier("scan.start")
    case .asking, .scanning:
      EmptyView()
    }
  }

  private func send() {
    guard armed, !model.isSending, let answer = scan.answer else {
      return
    }

    let model = self.model

    Task {
      await model.answer(answer)
    }
  }
}

/// Where the system keeps what a person allowed: opened from a sheet that says a permission was refused.
enum SystemSettings {
  enum Pane {
    case camera, microphone
  }

  @MainActor
  static func open(_ pane: Pane) {
    #if os(iOS)
      if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
      }
    #else
      let anchor = pane == .camera ? "Privacy_Camera" : "Privacy_Microphone"

      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
        NSWorkspace.shared.open(url)
      }
    #endif
  }
}
