import AVFoundation
import HermieCore
import HermieProtocol
import SwiftUI

#if os(iOS)
  import UIKit
  import Vision
  import VisionKit
#else
  import AppKit
#endif

/// The camera view of the code scanner: VisionKit's `DataScannerViewController` where the device has it (iPhone and
/// iPad), a plain capture session with a metadata output everywhere else (a Mac with a camera, an iPhone or iPad
/// whose scanner is not available). It looks only for the symbologies it is given, reports the first code it reads
/// (decoded text and kind) and nothing else, and never opens what it reads.
///
/// It is made only once the person pressed Scan on our sheet and the system let the camera be used: it does not ask
/// for the camera itself.
struct CodeScannerView: View {
  let symbologies: [ScanSymbology]
  /// A code was read: its decoded text, as the camera read it (uncleaned), and its kind.
  let onCode: @MainActor (String, ScanSymbology) -> Void
  /// The camera could not run.
  let onFailure: @MainActor () -> Void

  var body: some View {
    #if os(iOS)
      if DataScannerView.isAvailable {
        DataScannerView(symbologies: symbologies, onCode: onCode, onFailure: onFailure)
      } else {
        CaptureScannerView(symbologies: symbologies, onCode: onCode, onFailure: onFailure)
      }
    #else
      CaptureScannerView(symbologies: symbologies, onCode: onCode, onFailure: onFailure)
    #endif
  }
}

// MARK: - The capture session (every platform)

/// `AVCaptureSession` with an `AVCaptureMetadataOutput`, confined to its own queue (starting a session blocks). The
/// delegate reports on that queue; the callbacks hop to the main actor.
final class CodeCaptureSession: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
  let session = AVCaptureSession()

  private let queue = DispatchQueue(label: "dev.hermie.code-scan")
  private let types: [AVMetadataObject.ObjectType]
  private let report: @Sendable (String, ScanSymbology) -> Void
  private let failed: @Sendable () -> Void
  private var configured = false
  private var reported = false

  init(
    symbologies: [ScanSymbology], report: @escaping @Sendable (String, ScanSymbology) -> Void,
    failed: @escaping @Sendable () -> Void
  ) {
    self.types = symbologies.compactMap(Self.metadataType(of:))
    self.report = report
    self.failed = failed
    super.init()
  }

  static func metadataType(of symbology: ScanSymbology) -> AVMetadataObject.ObjectType? {
    switch symbology {
    case .qr: .qr
    case .ean13: .ean13
    case .ean8: .ean8
    case .code128: .code128
    case .pdf417: .pdf417
    case .datamatrix: .dataMatrix
    case .aztec: .aztec
    case .unknown: nil
    }
  }

  static func symbology(of type: AVMetadataObject.ObjectType) -> ScanSymbology? {
    switch type {
    case .qr: .qr
    case .ean13: .ean13
    case .ean8: .ean8
    case .code128: .code128
    case .pdf417: .pdf417
    case .dataMatrix: .datamatrix
    case .aztec: .aztec
    default: nil
    }
  }

  func start() {
    queue.async { [self] in
      reported = false

      if !configured {
        guard configure() else {
          failed()
          return
        }
      }

      if !session.isRunning {
        session.startRunning()
      }
    }
  }

  func stop() {
    queue.async { [self] in
      if session.isRunning {
        session.stopRunning()
      }
    }
  }

  /// On the queue.
  private func configure() -> Bool {
    guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else {
      return false
    }

    session.beginConfiguration()
    defer { session.commitConfiguration() }

    guard session.canAddInput(input) else {
      return false
    }

    session.addInput(input)

    let output = AVCaptureMetadataOutput()

    guard session.canAddOutput(output) else {
      return false
    }

    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: queue)

    let available = Set(output.availableMetadataObjectTypes)
    let wanted = types.filter(available.contains)

    guard !wanted.isEmpty else {
      return false
    }

    output.metadataObjectTypes = wanted
    configured = true
    return true
  }

  // MARK: AVCaptureMetadataOutputObjectsDelegate

  func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection
  ) {
    guard !reported else {
      return
    }

    for object in metadataObjects {
      guard let code = object as? AVMetadataMachineReadableCodeObject, let value = code.stringValue, !value.isEmpty,
        let symbology = Self.symbology(of: code.type)
      else {
        continue
      }

      reported = true
      report(value, symbology)
      return
    }
  }
}

#if os(iOS)
  /// The preview layer's own view: a layer of the right class, so it resizes with the view.
  final class CapturePreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
      // `layerClass` makes the cast always hold.
      layer as! AVCaptureVideoPreviewLayer  // swiftlint:disable:this force_cast
    }
  }

  struct CaptureScannerView: UIViewRepresentable {
    let symbologies: [ScanSymbology]
    let onCode: @MainActor (String, ScanSymbology) -> Void
    let onFailure: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
      Coordinator(symbologies: symbologies, onCode: onCode, onFailure: onFailure)
    }

    func makeUIView(context: Context) -> CapturePreviewUIView {
      let view = CapturePreviewUIView()
      view.previewLayer.session = context.coordinator.capture.session
      view.previewLayer.videoGravity = .resizeAspectFill
      context.coordinator.capture.start()
      return view
    }

    func updateUIView(_ view: CapturePreviewUIView, context: Context) {}

    static func dismantleUIView(_ view: CapturePreviewUIView, coordinator: Coordinator) {
      coordinator.capture.stop()
    }

    final class Coordinator {
      let capture: CodeCaptureSession

      init(
        symbologies: [ScanSymbology], onCode: @escaping @MainActor (String, ScanSymbology) -> Void,
        onFailure: @escaping @MainActor () -> Void
      ) {
        capture = CodeCaptureSession(
          symbologies: symbologies,
          report: { value, symbology in Task { @MainActor in onCode(value, symbology) } },
          failed: { Task { @MainActor in onFailure() } })
      }
    }
  }

  // MARK: VisionKit (iPhone and iPad)

  struct DataScannerView: UIViewControllerRepresentable {
    let symbologies: [ScanSymbology]
    let onCode: @MainActor (String, ScanSymbology) -> Void
    let onFailure: @MainActor () -> Void

    /// The device has the scanner and may use the camera.
    @MainActor static var isAvailable: Bool {
      DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    static func visionSymbology(of symbology: ScanSymbology) -> VNBarcodeSymbology? {
      switch symbology {
      case .qr: .qr
      case .ean13: .ean13
      case .ean8: .ean8
      case .code128: .code128
      case .pdf417: .pdf417
      case .datamatrix: .dataMatrix
      case .aztec: .aztec
      case .unknown: nil
      }
    }

    static func symbology(of vision: VNBarcodeSymbology) -> ScanSymbology? {
      ScanSymbology.knownCases.first { visionSymbology(of: $0) == vision }
    }

    func makeCoordinator() -> Coordinator {
      Coordinator(onCode: onCode, onFailure: onFailure)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
      let wanted = symbologies.compactMap(Self.visionSymbology(of:))
      let controller = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: wanted)],
        qualityLevel: .balanced,
        recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false,
        isPinchToZoomEnabled: true,
        isGuidanceEnabled: true,
        isHighlightingEnabled: true)
      controller.delegate = context.coordinator
      return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
      if !controller.isScanning, !context.coordinator.failed {
        do {
          try controller.startScanning()
        } catch {
          context.coordinator.failed = true
          onFailure()
        }
      }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
      controller.stopScanning()
    }

    // VisionKit calls its delegate on the main thread, and the protocol is not main-actor isolated in every SDK.
    @MainActor
    final class Coordinator: NSObject, @preconcurrency DataScannerViewControllerDelegate {
      let onCode: @MainActor (String, ScanSymbology) -> Void
      let onFailure: @MainActor () -> Void
      var failed = false
      private var reported = false

      init(onCode: @escaping @MainActor (String, ScanSymbology) -> Void, onFailure: @escaping @MainActor () -> Void) {
        self.onCode = onCode
        self.onFailure = onFailure
      }

      func dataScanner(
        _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]
      ) {
        guard !reported else {
          return
        }

        for item in addedItems {
          guard case .barcode(let barcode) = item, let value = barcode.payloadStringValue, !value.isEmpty,
            let symbology = DataScannerView.symbology(of: barcode.observation.symbology)
          else {
            continue
          }

          reported = true
          dataScanner.stopScanning()
          onCode(value, symbology)
          return
        }
      }

      func dataScanner(
        _ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
      ) {
        failed = true
        onFailure()
      }
    }
  }
#else
  /// The preview layer's own view on the Mac.
  final class CapturePreviewNSView: NSView {
    let previewLayer = AVCaptureVideoPreviewLayer()

    override init(frame: NSRect) {
      super.init(frame: frame)
      wantsLayer = true
      layer = previewLayer
      previewLayer.videoGravity = .resizeAspectFill
    }

    required init?(coder: NSCoder) {
      fatalError("init(coder:) is not used")
    }
  }

  struct CaptureScannerView: NSViewRepresentable {
    let symbologies: [ScanSymbology]
    let onCode: @MainActor (String, ScanSymbology) -> Void
    let onFailure: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
      Coordinator(symbologies: symbologies, onCode: onCode, onFailure: onFailure)
    }

    func makeNSView(context: Context) -> CapturePreviewNSView {
      let view = CapturePreviewNSView()
      view.previewLayer.session = context.coordinator.capture.session
      context.coordinator.capture.start()
      return view
    }

    func updateNSView(_ view: CapturePreviewNSView, context: Context) {}

    static func dismantleNSView(_ view: CapturePreviewNSView, coordinator: Coordinator) {
      coordinator.capture.stop()
    }

    final class Coordinator {
      let capture: CodeCaptureSession

      init(
        symbologies: [ScanSymbology], onCode: @escaping @MainActor (String, ScanSymbology) -> Void,
        onFailure: @escaping @MainActor () -> Void
      ) {
        capture = CodeCaptureSession(
          symbologies: symbologies,
          report: { value, symbology in Task { @MainActor in onCode(value, symbology) } },
          failed: { Task { @MainActor in onFailure() } })
      }
    }
  }
#endif
