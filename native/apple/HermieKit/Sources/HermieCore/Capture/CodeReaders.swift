import Foundation
import HermieProtocol
import Vision

extension ScanSymbology {
  /// The kind as Vision names it; nil for a kind this build does not know.
  public var visionSymbology: VNBarcodeSymbology? {
    switch self {
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

  /// The contract's kind for what Vision read; nil for a kind the contract does not name.
  public init?(vision: VNBarcodeSymbology) {
    guard let known = Self.knownCases.first(where: { $0.visionSymbology == vision }) else {
      return nil
    }

    self = known
  }
}

/// What this device can read codes WITH, apart from the camera itself: Vision reads a barcode out of any
/// image, so a camera that hands over frames is enough. Asked when the connection announces its requests, so
/// `device.scan` is only offered where a reader exists (the Mac's capture metadata output offers no barcode
/// types, which is why the frames go to Vision there).
public enum CodeReaders {
  /// The kinds Vision reads on this device, as the contract names them.
  public static func visionReads() -> [ScanSymbology] {
    let supported = (try? VNDetectBarcodesRequest().supportedSymbologies()) ?? []
    return ScanSymbology.knownCases.filter { kind in
      kind.visionSymbology.map(supported.contains) ?? false
    }
  }

  /// A reader exists: Vision reads at least QR codes here.
  public static var isAvailable: Bool {
    visionReads().contains(.qr)
  }
}
