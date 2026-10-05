import HermieCore
import HermieProtocol
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/**
 "Scan QR code" in setup: the camera on a gateway's code, or a picture of one (NX-14).

 The camera turns on only when Scan is pressed (the system asks for it then, the first time), and
 goes off when the app leaves the front or the sheet goes. The picture comes from the photo picker,
 which hands over only the picture the person chose, so it needs no photo-library permission, and is
 read with Vision. Either way what is read is SHOWN as an offer, never opened, and taken only when the
 person presses Continue: setup then fills the address and name in and goes straight to sign-in.

 A code that is not a Hermie gateway code, or whose address is not acceptable (plain http to a host that
 is not this machine or a `.local` name), is refused in a sentence and nothing else happens.
 */
struct ScanGatewaySheet: View {
  /// The person took the offer: setup uses it.
  let use: (GatewayPairingOffer) -> Void
  let cancel: () -> Void

  @State private var scan = PairingScanModel()
  @State private var photo: PhotosPickerItem?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(AppLaunch.self) private var launch

  private typealias Words = NativeStrings.Pairing.Sheet

  var body: some View {
    NavigationStack {
      Form {
        switch scan.phase {
        case .ready:
          readySections
        case .asking:
          Section { ProgressView().frame(maxWidth: .infinity) }
            .accessibilityIdentifier("hermie.pairing.asking")
        case .scanning:
          scanningSection
        case .found(let offer):
          PairingOfferSummary(offer: offer)

          // The same rule as a link's confirmation: a gateway this device has cannot be added again.
          let have = launch.gateways.entries.contains { offer.matches(address: $0.address) }

          if have {
            Section {
              Label(NativeStrings.Pairing.Offer.have, systemImage: "checkmark.circle")
                .accessibilityIdentifier("hermie.pairing.have")
            }
          }

          StepPrimarySection(title: NativeStrings.Pairing.Offer.add, enabled: !have, busy: false) {
            use(offer)
          }
          againSection
        case .refused(let problem):
          Section {
            Label(NativeStrings.Pairing.problem(problem), systemImage: "exclamationmark.triangle")
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("hermie.pairing.refused")
          }
          againSection
        case .unavailable(let reason):
          unavailableSection(reason)
        }

        if scan.readingImage {
          Section { ProgressView().frame(maxWidth: .infinity) }
            .accessibilityIdentifier("hermie.pairing.reading")
        } else if scan.phase == .ready || scan.unavailable != nil {
          pictureSection
        }
      }
      .formStyle(.grouped)
      .navigationTitle(Words.title)
      .toolbar { StepToolbar(cancel: cancel) }
    }
    #if os(macOS)
      .frame(minWidth: 480, idealWidth: 520, minHeight: 480, idealHeight: 560)
    #endif
    // The camera goes off when the app is not in front, and when the sheet goes.
    .onChange(of: scenePhase) { _, phase in
      if phase != .active {
        scan.pause()
      }
    }
    .onChange(of: scan.offer) { _, offer in
      if offer != nil {
        AccessibilityNotification.Announcement(Words.found).post()
      }
    }
    .onChange(of: photo) { _, item in
      guard let item else {
        return
      }

      Task { await read(item) }
    }
    .onDisappear { scan.pause() }
    .accessibilityIdentifier("hermie.pairing.scan")
  }

  // MARK: Sections

  @ViewBuilder private var readySections: some View {
    Section {
      Text(Words.intro)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("hermie.pairing.intro")

      if CameraDevices.isAvailable {
        Button(Words.start, systemImage: "qrcode.viewfinder") {
          Task { await scan.start() }
        }
        .accessibilityIdentifier("hermie.pairing.start")
      }
    }
  }

  private var scanningSection: some View {
    Section {
      CodeScannerView(
        symbologies: [.qr],
        onCode: { value, _ in scan.detected(value) },
        onFailure: { scan.scannerFailed() }
      )
      .frame(height: 320)
      .clipShape(.rect(cornerRadius: 12))
      .accessibilityLabel(Words.camera)
      .accessibilityIdentifier("hermie.pairing.camera")

      Text(Words.aim)
        .font(.callout)
        .foregroundStyle(.secondary)
    }
    .listRowInsets(EdgeInsets())
  }

  private var againSection: some View {
    Section {
      Button(Words.again, systemImage: "arrow.clockwise") {
        photo = nil
        scan.reset()
      }
      .accessibilityIdentifier("hermie.pairing.again")
    }
  }

  private var pictureSection: some View {
    Section {
      PhotosPicker(selection: $photo, matching: .images) {
        Label(Words.chooseImage, systemImage: "photo")
      }
      .accessibilityIdentifier("hermie.pairing.chooseImage")
    }
  }

  private func unavailableSection(_ reason: PairingScanModel.Unavailable) -> some View {
    Section {
      Label(unavailableText(reason), systemImage: "camera.metering.unknown")
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("hermie.pairing.unavailable")

      if reason == .denied {
        Button(NativeStrings.DeviceRequests.openSettings) {
          SystemSettings.open(.camera)
        }
        .accessibilityIdentifier("hermie.pairing.openSettings")
      }
    }
  }

  private func unavailableText(_ reason: PairingScanModel.Unavailable) -> String {
    switch reason {
    case .denied: Words.denied
    case .restricted: Words.restricted
    case .noCamera: Words.noCamera
    }
  }

  // MARK: The picture

  private func read(_ item: PhotosPickerItem) async {
    // A picture the library cannot give, or one that is too big, is a picture with no code in it.
    let data = (try? await item.loadTransferable(type: PickedQRImage.self))?.data ?? Data()

    await scan.importImage(data)
  }
}

/**
 A picture out of the photo picker, read as a FILE first: the picker hands over a file, its size is looked at,
 and only a picture within `PairingQRCode.maxImageBytes` is read into memory (mapped, not copied). Asked for as
 plain `Data`, the whole of a picture of any size would be loaded before anything could be said about it.
 */
struct PickedQRImage: Transferable {
  let data: Data

  struct TooLarge: Error {}

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      let size = try received.file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max

      guard size <= PairingQRCode.maxImageBytes else {
        throw TooLarge()
      }

      return PickedQRImage(data: try Data(contentsOf: received.file, options: .mappedIfSafe))
    }
  }
}
