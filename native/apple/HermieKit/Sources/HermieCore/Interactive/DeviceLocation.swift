import Foundation
import HermieProtocol
import Observation

// `device.location` (contract/requests/README.md §9): where the device is now, once, at the
// precision the person agrees to.
//
// The order is the contract's and never the system's: the sheet says what would be shared and at
// which precision (the person may lower `precise` to `approximate`, never raise), Share is the
// person's yes, and only then does the system's own permission prompt come. One fix, never
// monitoring.

/// A `device.location` request, read strictly (`DeviceLocationRequest.read`).
public struct DeviceLocationRequest: Sendable, Equatable {
  /// What the agent asked for.
  public var precision: LocationPrecision

  /// `nil` when the precision is one this build does not know.
  public static func read(_ params: DeviceLocationParams) -> DeviceLocationRequest? {
    switch params.precision {
    case .approximate?: DeviceLocationRequest(precision: .approximate)
    case .precise?: DeviceLocationRequest(precision: .precise)
    default: nil
    }
  }
}

/// One position as the system gave it: before anything is cut.
public struct LocationFix: Sendable, Equatable {
  public var latitude: Double
  public var longitude: Double
  /// The horizontal accuracy in metres, as the system reported it.
  public var accuracyMeters: Double
  /// When the position was taken, on this device's clock.
  public var time: Date
  /// The system gave a reduced-accuracy position whatever was asked: the person chose "Approximate"
  /// in the permission prompt (or in Settings) for this app.
  public var isReduced: Bool

  public init(latitude: Double, longitude: Double, accuracyMeters: Double, time: Date, isReduced: Bool = false) {
    self.latitude = latitude
    self.longitude = longitude
    self.accuracyMeters = accuracyMeters
    self.time = time
    self.isReduced = isReduced
  }
}

/// What asking the system for one position came to.
public enum LocationOutcome: Sendable, Equatable {
  /// A position.
  case fix(LocationFix)
  /// The person (or a restriction) refused location access to this app.
  case denied
  /// No position: Location Services are off, or the system could not find one in time.
  case unavailable
}

/// The system's one-shot position, behind a seam so the sheet's rules can be tested: the model never
/// touches CoreLocation.
@MainActor
public protocol DeviceLocationProvider: Sendable {
  /// One position. `approximate` asks the OS for reduced accuracy (it never even computes a precise
  /// one); the system's permission prompt appears the first time, from here. Never monitors.
  func locate(precision: LocationPrecision) async -> LocationOutcome
}

/// The position a person agreed to share: what the answer carries, and nothing more precise.
public struct SharedLocation: Sendable, Equatable {
  public var latitude: Double
  public var longitude: Double
  public var accuracyMeters: Double
  /// Unix seconds, on this device's clock.
  public var at: Int
  /// What was shared, which is not always what was asked for or chosen (a reduced fix is approximate).
  public var precision: LocationPrecision

  /// The nearest hundredth of a degree is about 1.1 km of latitude: what an `approximate` answer is
  /// cut to, as the gateway cuts it (the gateway's rounding is no reason to send more).
  static let approximateDecimals = 100.0
  /// An approximate answer never says it is more accurate than this, in metres.
  static let approximateAccuracyFloor = 1_000.0
  /// A precise answer keeps six decimals, as the gateway does.
  static let preciseDecimals = 1_000_000.0
  /// The contract's bound on `accuracy_m`.
  static let accuracyCeiling = 10_000_000.0
  /// The contract's bound on `at`.
  static let atCeiling = 9_007_199_254_740_992

  /// The answer for `fix` at the precision the person `chose`, cut to what that precision allows.
  /// `nil` for a fix that is not a position (a coordinate out of range or not a number, an accuracy
  /// that is negative, as the system reports for no fix, or not a number).
  public init?(fix: LocationFix, chose precision: LocationPrecision) {
    guard fix.latitude.isFinite, fix.longitude.isFinite, fix.accuracyMeters.isFinite,
      abs(fix.latitude) <= 90, abs(fix.longitude) <= 180, fix.accuracyMeters >= 0
    else {
      return nil
    }

    let seconds = fix.time.timeIntervalSince1970

    guard seconds.isFinite, seconds >= 0, seconds < Double(Self.atCeiling) else {
      return nil
    }

    // A reduced fix is approximate whatever the person chose to share: that is what it is.
    let shared: LocationPrecision = precision == .precise && !fix.isReduced ? .precise : .approximate

    switch shared {
    case .precise:
      latitude = Self.rounded(fix.latitude, to: Self.preciseDecimals)
      longitude = Self.rounded(fix.longitude, to: Self.preciseDecimals)
      accuracyMeters = min(fix.accuracyMeters, Self.accuracyCeiling)
    default:
      // Even when the system gave more: nothing finer than the approximate grid leaves the device.
      latitude = Self.rounded(fix.latitude, to: Self.approximateDecimals)
      longitude = Self.rounded(fix.longitude, to: Self.approximateDecimals)
      accuracyMeters = min(max(fix.accuracyMeters, Self.approximateAccuracyFloor), Self.accuracyCeiling)
    }

    at = Int(seconds)
    self.precision = shared
  }

  private static func rounded(_ value: Double, to scale: Double) -> Double {
    let result = (value * scale).rounded(.toNearestOrAwayFromZero) / scale
    // -0.0 reads as 0 in the answer.
    return result == 0 ? 0 : result
  }

  /// Whether the contract lets this answer a request for `request`: in range, and never more
  /// precise than asked (the gateway refuses that, `precision:too_precise`).
  func isValid(for request: DeviceLocationRequest) -> Bool {
    guard request.precision == .precise || precision == .approximate,
      precision == .precise || precision == .approximate
    else {
      return false
    }

    return latitude.isFinite && longitude.isFinite && accuracyMeters.isFinite && abs(latitude) <= 90
      && abs(longitude) <= 180 && accuracyMeters >= 0 && accuracyMeters <= Self.accuracyCeiling && at >= 0
      && at < Self.atCeiling
  }

  var result: DeviceLocationResult {
    .answered(lat: latitude, lon: longitude, accuracyMeters: accuracyMeters, at: at, precision: precision)
  }
}

/// What the person pressing Share comes to: the answer, or the reason the request cannot be shown.
public enum DeviceStep: Sendable, Equatable {
  /// Send this answer.
  case answer(InteractiveAnswer)
  /// The sheet cannot go on: answer `4041 cannot_show` with this reason, and tell the person.
  case cannotShow(reason: String)
}

extension InteractiveModel {
  /// Do what a device sheet's step came to: send the answer, or tell the bot the request cannot be
  /// shown (`4041`) and leave a notice on the chat, since a refused permission or a missing
  /// position is for the person to see too. Answers whether it went out.
  @discardableResult
  public func perform(_ step: DeviceStep) async -> Bool {
    switch step {
    case .answer(let answer): await self.answer(answer)
    case .cannotShow(let reason): await cannotShow(reason: reason, notify: true)
    }
  }
}

/// The state of one `device.location` sheet: what will be shared, and getting it.
@MainActor
@Observable
public final class InteractiveLocationModel {
  public enum Phase: Sendable, Equatable {
    /// The sheet says what would be shared; nothing was asked of the system.
    case ready
    /// The system is asked (its prompt may be up).
    case locating
  }

  public let request: DeviceLocationRequest
  /// What will be shared: the request's precision, or less.
  public private(set) var precision: LocationPrecision
  public private(set) var phase = Phase.ready

  @ObservationIgnored private let provider: any DeviceLocationProvider
  @ObservationIgnored private let now: @Sendable () -> Date

  public init(
    request: DeviceLocationRequest,
    provider: any DeviceLocationProvider,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.request = request
    self.precision = request.precision
    self.provider = provider
    self.now = now
  }

  /// The person may share less than was asked (`precise` to `approximate`), never more.
  public var canChoosePrecision: Bool {
    request.precision == .precise
  }

  /// Choose what to share. Only a precision no finer than the request's is taken.
  public func choose(_ precision: LocationPrecision) {
    guard phase == .ready else {
      return
    }

    if precision == .approximate || (precision == .precise && request.precision == .precise) {
      self.precision = precision
    }
  }

  public var isLocating: Bool {
    phase == .locating
  }

  /// The person pressed Share: now, and only now, the system is asked. Answers what to do next;
  /// `nil` when a fix is already being taken, or the task was cancelled meanwhile.
  public func share() async -> DeviceStep? {
    guard phase == .ready else {
      return nil
    }

    phase = .locating
    let chosen = precision
    let outcome = await provider.locate(precision: chosen)
    phase = .ready

    // The sheet went away while the system was asked (the lock covered it, the chat was left): the
    // person decided nothing, so nothing is answered.
    if Task.isCancelled {
      return nil
    }

    switch outcome {
    case .denied:
      return .cannotShow(reason: CannotShowReason.permissionDenied)
    case .unavailable:
      return .cannotShow(reason: CannotShowReason.locationUnavailable)
    case .fix(let fix):
      // The position is stamped with the clock of the device when it was taken, unless the system
      // gave none.
      var stamped = fix

      if fix.time.timeIntervalSince1970 <= 0 {
        stamped.time = now()
      }

      guard let shared = SharedLocation(fix: stamped, chose: chosen) else {
        return .cannotShow(reason: CannotShowReason.locationUnavailable)
      }

      return .answer(.location(shared))
    }
  }
}
