import Foundation
import HermieProtocol

#if canImport(CoreLocation)
  import CoreLocation

  /// The device's one-shot position, from CoreLocation.
  ///
  /// - Never before Share: nothing here runs until `locate(precision:)`, and the permission prompt
  ///   (`requestWhenInUseAuthorization`) is the first thing it does when permission was never asked.
  /// - `approximate` sets `desiredAccuracy` to `kCLLocationAccuracyReduced`, so the OS never even
  ///   computes a precise position for it; `precise` asks for the best the device has. Either way
  ///   the person's own choice in the system prompt wins: a reduced-accuracy authorization
  ///   (`accuracyAuthorization`) is reported as `isReduced`.
  /// - One fix through `requestLocation`, never `startUpdatingLocation`: nothing keeps running, and
  ///   a fix that does not come in `timeout` is "unavailable".
  @MainActor
  public final class SystemLocationProvider: NSObject, DeviceLocationProvider, @preconcurrency CLLocationManagerDelegate {
    /// One provider for the app: the system's manager is made on the first Share, never before.
    public static let shared = SystemLocationProvider()

    private lazy var manager: CLLocationManager = {
      let manager = CLLocationManager()
      manager.delegate = self
      return manager
    }()
    private let timeout: Duration

    private var authorization: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var fix: CheckedContinuation<LocationOutcome, Never>?
    private var deadline: Task<Void, Never>?

    public init(timeout: Duration = .seconds(20)) {
      self.timeout = timeout
      super.init()
    }

    public func locate(precision: LocationPrecision) async -> LocationOutcome {
      guard fix == nil, authorization == nil else {
        return .unavailable
      }

      // `locationServicesEnabled` can block, so it is asked off the main actor.
      guard await Task.detached(operation: { CLLocationManager.locationServicesEnabled() }).value else {
        return .unavailable
      }

      var status = manager.authorizationStatus

      if status == .notDetermined {
        status = await requestAuthorization()
      }

      switch status {
      case .authorizedAlways, .authorizedWhenInUse:
        break
      case .notDetermined:
        // The prompt was never answered (the sheet went away): nothing was granted.
        return .unavailable
      default:
        return .denied
      }

      if Task.isCancelled {
        return .unavailable
      }

      manager.desiredAccuracy = precision == .approximate ? kCLLocationAccuracyReduced : kCLLocationAccuracyBest
      return await requestFix()
    }

    // MARK: Permission

    private func requestAuthorization() async -> CLAuthorizationStatus {
      await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
          authorization = continuation
          manager.requestWhenInUseAuthorization()
        }
      } onCancel: {
        Task { @MainActor in
          self.resolveAuthorization(.notDetermined)
        }
      }
    }

    private func resolveAuthorization(_ status: CLAuthorizationStatus) {
      authorization?.resume(returning: status)
      authorization = nil
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
      // The callback that comes with the manager itself says nothing was decided yet.
      if manager.authorizationStatus != .notDetermined {
        resolveAuthorization(manager.authorizationStatus)
      }
    }

    // MARK: One fix

    private func requestFix() async -> LocationOutcome {
      await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
          fix = continuation
          deadline = Task { [timeout] in
            try? await Task.sleep(for: timeout)

            if !Task.isCancelled {
              self.resolveFix(.unavailable)
            }
          }
          manager.requestLocation()
        }
      } onCancel: {
        Task { @MainActor in
          self.resolveFix(.unavailable)
        }
      }
    }

    private func resolveFix(_ outcome: LocationOutcome) {
      deadline?.cancel()
      deadline = nil
      fix?.resume(returning: outcome)
      fix = nil
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
      guard let location = locations.last else {
        resolveFix(.unavailable)
        return
      }

      resolveFix(
        .fix(
          LocationFix(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            time: location.timestamp,
            isReduced: manager.accuracyAuthorization == .reducedAccuracy
          )
        )
      )
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
      if (error as? CLError)?.code == .denied {
        resolveFix(.denied)
      } else {
        resolveFix(.unavailable)
      }
    }
  }
#endif
