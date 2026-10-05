import Foundation
import Observation

/**
 Reading a gateway's QR code, from the camera or from a picture (NX-14): the state behind "Scan QR"
 in the setup flow.

 Like the code scanner a bot can ask for (`InteractiveScanModel`), the camera is not touched, and
 the system's permission prompt is not shown, until the person pressed Scan on our sheet (`start()`).
 Unlike it, what is read is never shown as text to send: it is only ever looked at as an offer
 (`GatewayPairingOffer`). A code that is not one is refused in a sentence, never opened, and a code
 that is one is SHOWN (name, host, whether it is secure) and taken only when the person says so;
 nothing here adds a gateway.

 The model knows nothing of a camera view. The sheet's scanner reports what it reads (`detected(_:)`)
 and that it could not run (`scannerFailed()`); a picture comes in through `importImage(_:)`; the
 camera's permission is asked through `CaptureAuthorizing`.
 */
@MainActor
@Observable
public final class PairingScanModel {
  /// Where the sheet is.
  public enum Phase: Sendable, Equatable {
    /// Nothing asked of the system yet: the sheet offers Scan and Choose a photo.
    case ready
    /// The system's camera prompt is up.
    case asking
    /// The camera is on, looking for a code.
    case scanning
    /// A code that is an offer was read, and is shown for the person to take.
    case found(GatewayPairingOffer)
    /// A code or a picture was read and holds no usable offer.
    case refused(GatewayPairingOffer.Problem)
    /// The camera cannot be used.
    case unavailable(Unavailable)
  }

  public enum Unavailable: Sendable, Equatable {
    /// The person said no to the camera (now or earlier).
    case denied
    /// A profile forbids the camera.
    case restricted
    /// There is no camera, or the scanner could not start.
    case noCamera
  }

  public private(set) var phase = Phase.ready

  /// A picture is being read (off the main actor): the sheet shows it is busy.
  public private(set) var readingImage = false

  @ObservationIgnored private let authorization: any CaptureAuthorizing
  /// What reads a picture's codes, off the main actor (Vision; a test holds it to order the race).
  @ObservationIgnored private let readCodes: @Sendable (Data) -> [String]
  /// Which picture the sheet is waiting for: a newer one, a reset or a code the camera read since makes
  /// an older answer stale.
  @ObservationIgnored private var imageTicket = 0

  public convenience init(authorization: any CaptureAuthorizing = SystemCaptureAuthorization()) {
    self.init(authorization: authorization, readCodes: { PairingQRCode.payloads(in: $0) })
  }

  init(authorization: any CaptureAuthorizing, readCodes: @escaping @Sendable (Data) -> [String]) {
    self.authorization = authorization
    self.readCodes = readCodes
  }

  /// The offer that was read, once there is one.
  public var offer: GatewayPairingOffer? {
    if case .found(let offer) = phase { offer } else { nil }
  }

  public var refusal: GatewayPairingOffer.Problem? {
    if case .refused(let problem) = phase { problem } else { nil }
  }

  public var unavailable: Unavailable? {
    if case .unavailable(let reason) = phase { reason } else { nil }
  }

  // MARK: - The camera

  /// The person pressed Scan: ask for the camera when the system has not been asked, then look.
  public func start() async {
    switch phase {
    case .ready, .unavailable, .refused:
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

  /// The scanner read a code. Only while it looks; the first one decides.
  public func detected(_ payload: String) {
    guard phase == .scanning, !payload.isEmpty else {
      return
    }

    imageTicket += 1
    readingImage = false

    switch GatewayPairingOffer.offer(fromPayload: payload) {
    case .success(let offer):
      phase = .found(offer)
    case .failure(let problem):
      phase = .refused(problem)
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

  // MARK: - A picture

  /// A picture the person chose: the first usable offer among its QR codes. A picture with no code,
  /// or none that is an offer, is refused in a sentence. The camera, when it was on, goes off.
  ///
  /// Vision runs off the main actor (a photo takes a moment), and what it finds is applied only if the
  /// sheet is still waiting for THIS picture and has not read an offer meanwhile.
  public func importImage(_ data: Data) async {
    imageTicket += 1

    let ticket = imageTicket

    readingImage = true

    let read = readCodes
    let payloads = await Task.detached(priority: .userInitiated) { read(data) }.value

    guard ticket == imageTicket else {
      return
    }

    readingImage = false

    if case .found = phase {
      return
    }

    switch GatewayPairingOffer.offer(fromPayloads: payloads) {
    case .success(let offer):
      phase = .found(offer)
    case .failure(let problem):
      phase = .refused(problem)
    }
  }

  /// Look again: back to the start, where Scan and Choose a photo are offered.
  public func reset() {
    imageTicket += 1
    readingImage = false

    switch phase {
    case .found, .refused:
      phase = .ready
    default:
      break
    }
  }
}
