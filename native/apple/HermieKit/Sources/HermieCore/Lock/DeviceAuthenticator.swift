import Foundation
import LocalAuthentication

/// What this device can offer to prove who is holding it. `BiometricEnrolment` in the Expo app.
public enum DeviceEnrolment: Sendable, Equatable {
  /// The platform cannot be asked at all.
  case unavailable
  /// Nothing is set up: no passcode, no face, no finger.
  case none
  /// A device passcode (or Mac password) and no biometrics.
  case passcode
  /// Face ID or Touch ID, with the passcode as fallback.
  case biometric

  /// Whether a lock switched on now could be opened again.
  public var canUnlock: Bool {
    self == .passcode || self == .biometric
  }
}

/// What the prompt answered. `unavailable` is the platform refusing to run it.
public enum AuthenticationVerdict: Sendable, Equatable {
  case ok
  case failed
  case unavailable
}

/**
 The device's own "prove it is you", behind one seam so tests and UI tests inject a fake.

 Two questions and no state: `AppLock` keeps every decision in `LockMachine`, and this only answers
 what the hardware can do and what the person in front of it just did.
 */
public protocol DeviceAuthenticator: Sendable {
  /// Synchronous, for the launch step that runs before the first frame.
  func canAuthenticate() -> Bool
  func enrolment() async -> DeviceEnrolment
  /// `reason` is the line the platform prints in its own prompt.
  func authenticate(reason: String) async -> AuthenticationVerdict
}

/**
 `LAContext` with `.deviceOwnerAuthentication`: biometrics, falling back to the device passcode
 (or the Mac's password). A fresh context per question, so no evaluation outlives its answer.
 */
public struct SystemAuthenticator: DeviceAuthenticator {
  public init() {}

  public func canAuthenticate() -> Bool {
    LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
  }

  public func enrolment() async -> DeviceEnrolment {
    let context = LAContext()
    var error: NSError?

    if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) {
      return .biometric
    }

    if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
      return .passcode
    }

    if let error, error.domain == LAError.errorDomain, error.code == LAError.Code.passcodeNotSet.rawValue {
      return .none
    }

    return .unavailable
  }

  public func authenticate(reason: String) async -> AuthenticationVerdict {
    let context = LAContext()
    var error: NSError?

    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      return .unavailable
    }

    do {
      return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .ok : .failed
    } catch {
      return .failed
    }
  }
}

#if DEBUG
  /**
   A device that answers from a script, for unit tests and the shell's UI tests. Debug builds only:
   a release build has no way to construct one, so no launch argument can stand in for a face.

   `verdicts` are answered in order and the last one repeats; `prompts` counts the questions.
   */
  public final class ScriptedAuthenticator: DeviceAuthenticator, @unchecked Sendable {
    // @unchecked: every stored property is guarded by `lock`.
    private let lock = NSLock()
    private var verdicts: [AuthenticationVerdict]
    private var _prompts = 0
    private var _enrolment: DeviceEnrolment

    public init(enrolment: DeviceEnrolment = .biometric, verdicts: [AuthenticationVerdict] = [.ok]) {
      self._enrolment = enrolment
      self.verdicts = verdicts.isEmpty ? [.failed] : verdicts
    }

    public var prompts: Int {
      lock.withLock { _prompts }
    }

    public func setEnrolment(_ enrolment: DeviceEnrolment) {
      lock.withLock { _enrolment = enrolment }
    }

    public func setVerdicts(_ next: [AuthenticationVerdict]) {
      lock.withLock { verdicts = next.isEmpty ? [.failed] : next }
    }

    public func canAuthenticate() -> Bool {
      lock.withLock { _enrolment.canUnlock }
    }

    public func enrolment() async -> DeviceEnrolment {
      lock.withLock { _enrolment }
    }

    public func authenticate(reason: String) async -> AuthenticationVerdict {
      lock.withLock {
        _prompts += 1

        guard _enrolment.canUnlock else {
          return .unavailable
        }

        return verdicts.count > 1 ? verdicts.removeFirst() : verdicts[0]
      }
    }
  }
#endif
