import AVFoundation
import HermieCore
import HermieProtocol
import SwiftUI
import Vision

#if os(iOS)
  import UIKit
  import VisionKit
#else
  import AppKit
#endif

/// The camera view of the code scanner: VisionKit's `DataScannerViewController` where the device has it (iPhone and
/// iPad), a plain capture session everywhere else (a Mac with a camera, an iPhone or iPad whose scanner is not
/// available): its metadata output where that offers barcode types, and where it offers none (the Mac's does not)
/// Vision on the video frames. It looks only for the symbologies it is given, reports the first code it reads
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

/// `AVCaptureSession` with an `AVCaptureMetadataOutput`, or, where that offers no barcode type, a video data output
/// whose frames go to Vision. Confined to its own queue (starting a session blocks). The delegates report on that
/// queue; the callbacks hop to the main actor.
final class CodeCaptureSession: NSObject, AVCaptureMetadataOutputObjectsDelegate,
  AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable
{
  let session = AVCaptureSession()

  /// How often a frame is read in Vision's mode: five a second is plenty for a code held still, and spares the
  /// battery.
  static let frameInterval: UInt64 = 200_000_000

  private let queue = DispatchQueue(label: "dev.hermie.code-scan")
  private let symbologies: [ScanSymbology]
  private let types: [AVMetadataObject.ObjectType]
  private let report: @Sendable (String, ScanSymbology) -> Void
  private let failed: @Sendable () -> Void
  private var configured = false
  private var reported = false
  private var lastFrame: UInt64 = 0

  init(
    symbologies: [ScanSymbology], report: @escaping @Sendable (String, ScanSymbology) -> Void,
    failed: @escaping @Sendable () -> Void
  ) {
    self.symbologies = symbologies
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

    // The types an output offers are only known once it is in a session with an input.
    let available = Set(output.availableMetadataObjectTypes)
    let wanted = types.filter(available.contains)

    if !wanted.isEmpty {
      output.metadataObjectTypes = wanted
      configured = true
      return true
    }

    // The metadata output offers none of the kinds asked for (on the Mac it offers no barcode type at all): read
    // the frames with Vision instead, rather than a scanner that never sees a code.
    session.removeOutput(output)
    return configureFrameReading()
  }

  /// On the queue, in the session's configuration.
  private func configureFrameReading() -> Bool {
    guard !VisionCodeReader.visionTypes(for: symbologies).isEmpty else {
      return false
    }

    let video = AVCaptureVideoDataOutput()
    video.alwaysDiscardsLateVideoFrames = true

    guard session.canAddOutput(video) else {
      return false
    }

    session.addOutput(video)
    video.setSampleBufferDelegate(self, queue: queue)
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

  // MARK: AVCaptureVideoDataOutputSampleBufferDelegate (Vision's mode)

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard !reported, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    let now = DispatchTime.now().uptimeNanoseconds

    guard now &- lastFrame >= Self.frameInterval else {
      return
    }

    lastFrame = now

    // A frame that cannot be read is no code; the next one is tried. Late frames are dropped by the output while
    // this one is read, on the queue.
    guard let code = try? VisionCodeReader.read(VNImageRequestHandler(cvPixelBuffer: pixels), wanting: symbologies) else {
      return
    }

    reported = true
    report(code.value, code.symbology)
  }
}

/// Reads one code out of an image with Vision, only of the kinds asked for. Where a platform's capture metadata
/// output reads none, this is the reader.
enum VisionCodeReader {
  /// The Vision kinds for these symbologies, those this device reads.
  static func visionTypes(for symbologies: [ScanSymbology]) -> [VNBarcodeSymbology] {
    let reads = Set(CodeReaders.visionReads())
    return symbologies.filter(reads.contains).compactMap(\.visionSymbology)
  }

  /// The first code in what `handler` holds, its decoded text and kind; nil when there is none of the kinds
  /// asked for. Throws when Vision could not run at all.
  static func read(_ handler: VNImageRequestHandler, wanting symbologies: [ScanSymbology]) throws -> (
    value: String, symbology: ScanSymbology
  )? {
    let wanted = visionTypes(for: symbologies)

    guard !wanted.isEmpty else {
      return nil
    }

    let request = VNDetectBarcodesRequest()
    request.symbologies = wanted
    try handler.perform([request])

    for observation in request.results ?? [] {
      guard let value = observation.payloadStringValue, !value.isEmpty,
        let symbology = ScanSymbology(vision: observation.symbology), symbologies.contains(symbology)
      else {
        continue
      }

      return (value, symbology)
    }

    return nil
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
      symbology.visionSymbology
    }

    static func symbology(of vision: VNBarcodeSymbology) -> ScanSymbology? {
      ScanSymbology(vision: vision)
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

    // VisionKit calls its delegate on the main thread; the protocol is main-actor isolated.
    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
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
