import AVFoundation
import Foundation

/// Whether the person has let this app use a capture device, and asking when the app has not asked yet. The system's
/// own prompt is the only consent: nothing here asks before the person pressed a button on a sheet of ours.
public enum CaptureAccess: Sendable, Equatable {
  /// The system has not asked yet.
  case notDetermined
  /// The person said yes.
  case granted
  /// The person said no (or has since turned it off in Settings).
  case denied
  /// A profile or parental setting forbids it: the person cannot change it here.
  case restricted
}

/// The camera and the microphone behind one seam: the system's in the app, a fake in the tests.
public protocol CaptureAuthorizing: Sendable {
  /// The camera's state, without asking.
  func cameraAccess() -> CaptureAccess
  /// Ask for the camera (the system's prompt, once) and wait. True when granted.
  func requestCamera() async -> Bool
  /// The microphone's state, without asking.
  func microphoneAccess() -> CaptureAccess
  /// Ask for the microphone (the system's prompt, once) and wait. True when granted.
  func requestMicrophone() async -> Bool
}

/// `AVCaptureDevice` for the camera and `AVAudioApplication` for the microphone.
public struct SystemCaptureAuthorization: CaptureAuthorizing {
  public init() {}

  public func cameraAccess() -> CaptureAccess {
    Self.access(AVCaptureDevice.authorizationStatus(for: .video))
  }

  public func requestCamera() async -> Bool {
    await AVCaptureDevice.requestAccess(for: .video)
  }

  public func microphoneAccess() -> CaptureAccess {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: .granted
    case .denied: .denied
    default: .notDetermined
    }
  }

  public func requestMicrophone() async -> Bool {
    await AVAudioApplication.requestRecordPermission()
  }

  static func access(_ status: AVAuthorizationStatus) -> CaptureAccess {
    switch status {
    case .authorized: .granted
    case .denied: .denied
    case .restricted: .restricted
    case .notDetermined: .notDetermined
    @unknown default: .denied
    }
  }
}

/// The capture devices this machine has, asked without prompting.
public enum CameraDevices {
  /// A camera exists and no profile restricts it. On an iPhone or iPad always (bar a restriction); on a Mac when it
  /// has a camera (built in, external, or a phone through Continuity Camera at the time of asking).
  public static var isAvailable: Bool {
    AVCaptureDevice.default(for: .video) != nil && AVCaptureDevice.authorizationStatus(for: .video) != .restricted
  }

  /// Whether the machine has a microphone to record with. (A Mac with no input has none; every iPhone and iPad has.)
  public static var hasMicrophone: Bool {
    AVCaptureDevice.default(for: .audio) != nil
  }
}
