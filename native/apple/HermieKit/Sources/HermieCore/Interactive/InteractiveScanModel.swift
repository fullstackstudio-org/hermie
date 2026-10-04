import Foundation
import HermieProtocol
import Observation

/// The one code of a `device.scan` request, from the person pressing Scan to the value they send.
///
/// The camera is not touched, and the system's permission prompt is not shown, until the person has pressed Scan
/// on our sheet (`start()`): the prompt is in addition to the sheet, never instead of it. A code that is read is
/// SHOWN first, as plain text and cleaned the way the gateway cleans it (`ScanValue`), and goes out only when the
/// person presses Send; Rescan looks for another. A code is never opened: no link is followed and no app launched.
///
/// The model knows nothing of a camera view. The sheet's scanner reports what it reads (`detected(_:as:)`) and
/// that it could not run (`scannerFailed()`); permission is asked through `CaptureAuthorizing`.
@MainActor
@Observable
public final class InteractiveScanModel {
  /// Where the sheet is.
  public enum Phase: Sendable, Equatable {
    /// Nothing asked of the system yet: the sheet says what it will do and offers Scan.
    case ready
    /// The system's camera prompt is up.
    case asking
    /// The camera is on, looking for a code.
    case scanning
    /// A code was read, and is shown for the person to send or to replace.
    case found(Found)
    /// The camera cannot be used.
    case unavailable(Unavailable)
  }

  /// A code that was read.
  public struct Found: Sendable, Equatable {
    /// The value as it will be sent: cleaned like the gateway cleans it.
    public var value: String
    public var symbology: ScanSymbology
    /// Cleaning removed or changed something (a hidden character, a control character): the sheet says so.
    public var wasCleaned: Bool
    /// Why it cannot be sent, when it cannot: nothing visible left, or too long.
    public var problem: ScanValue.Problem?
    /// What the sheet shows: `value`, cut when it is very long (the cut is never sent: such a value cannot be).
    public var preview: String

    /// It can be sent.
    public var isSendable: Bool { problem == nil }
  }

  public enum Unavailable: Sendable, Equatable {
    /// The person said no to the camera (now or earlier).
    case denied
    /// A profile forbids the camera.
    case restricted
    /// There is no camera, or the scanner could not start.
    case noCamera

    /// The `cannot_show` reason that tells the bot why.
    public var reason: String {
      switch self {
      case .denied, .restricted: CannotShowReason.permissionDenied
      case .noCamera: CannotShowReason.noCamera
      }
    }
  }

  public let request: ScanRequest
  public private(set) var phase = Phase.ready

  @ObservationIgnored private let authorization: any CaptureAuthorizing
  /// The longest value shown in full.
  private static let previewScalars = 1_000

  public init(request: ScanRequest, authorization: any CaptureAuthorizing = SystemCaptureAuthorization()) {
    self.request = request
    self.authorization = authorization
  }

  /// The symbologies the scanner is asked to look for: the request's, or every one the contract names.
  public var symbologies: [ScanSymbology] {
    request.formats.isEmpty ? ScanSymbology.knownCases : request.formats
  }

  // MARK: - Scan

  /// The person pressed Scan: ask for the camera when the system has not been asked, then look.
  public func start() async {
    switch phase {
    case .ready, .unavailable:
      break
    default:
      return
    }

    switch authorization.cameraAccess() {
    case .granted:
      phase = .scanning
    case .denied:
      phase = .unavailable(.denied)
    case .restricted:
      phase = .unavailable(.restricted)
    case .notDetermined:
      phase = .asking
      let granted = await authorization.requestCamera()

      // The sheet went away, or the person went back, while the prompt was up.
      guard phase == .asking else {
        return
      }

      phase = granted ? .scanning : .unavailable(.denied)
    }
  }

  /// The scanner read a code. Only while it looks, and only a kind the request asks for; the first one wins and the
  /// rest wait for Rescan.
  public func detected(_ raw: String, as symbology: ScanSymbology) {
    guard phase == .scanning, request.accepts(symbology), !raw.isEmpty else {
      return
    }

    let cleaned = ScanValue.clean(raw)
    let problem = ScanValue.problem(in: cleaned)
    let scalars = cleaned.unicodeScalars
    let preview = scalars.count > Self.previewScalars ? ScanValue.prefix(cleaned, scalars: Self.previewScalars) + "…" : cleaned

    phase = .found(
      Found(value: cleaned, symbology: symbology, wasCleaned: cleaned != raw, problem: problem, preview: preview))
  }

  /// Look for another code.
  public func rescan() {
    if case .found = phase {
      phase = .scanning
    }
  }

  /// The scanner could not run (no camera after all, the session failed).
  public func scannerFailed() {
    switch phase {
    case .scanning, .asking:
      phase = .unavailable(.noCamera)
    default:
      break
    }
  }

  /// The camera goes off (the sheet went away, or the app left the front).
  public func pause() {
    if phase == .scanning {
      phase = .ready
    }
  }

  // MARK: - Answer

  /// The answer for what was found, nil unless it can be sent.
  public var answer: InteractiveAnswer? {
    guard case .found(let found) = phase, found.isSendable else {
      return nil
    }

    return .scan(value: found.value, symbology: found.symbology)
  }

  public var found: Found? {
    if case .found(let found) = phase { return found }
    return nil
  }

  public var unavailable: Unavailable? {
    if case .unavailable(let reason) = phase { return reason }
    return nil
  }
}

extension ScanValue {
  /// At most `limit` code points of `text`.
  static func prefix(_ text: String, scalars limit: Int) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: text.unicodeScalars.prefix(limit))
    return String(view)
  }
}
