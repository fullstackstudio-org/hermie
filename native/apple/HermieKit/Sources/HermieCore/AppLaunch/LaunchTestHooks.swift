#if DEBUG
  import Foundation
  import HermieStore

  /**
   The switches the shell's UI tests launch the app with. Debug builds only: nothing here is
   compiled into a release build, so no launch argument can replace the authenticator, seed a lock
   or point the app at another directory there.

   Active only with `-HermieUITest YES`. Every run gets a fresh data directory of its own (or the
   one named by `-HermieDataDirectory`), so a test never meets the store of a real install.

   Every switch takes a value, the switches included (`YES`): AppKit reads launch arguments as
   `-key value` pairs, and a bare switch followed by a path leaves the path on its own, where the
   Mac takes it for a document to open and launches without a window.

   - `-HermieFakeAuth fail,ok` the scripted prompt's answers, in order, the last one repeating
   - `-HermieFakeEnrolment biometric|passcode|none|unavailable`
   - `-HermieSeedLock '{"threshold":"5m"}'` the raw text written to `hermie.lock`
   - `-HermieSeedGateway 'Name|http://host:port'` repeatable; the first becomes active
   - `-HermieLaunchTrace YES` record what the lock gate drew, in order, for the first-frame test
   - `-HermieOpenSettings YES` open the Settings window at launch (Mac)
   - `-HermieOpenURL 'hermie://…'` handle a link as if the system had delivered it
   */
  public struct LaunchTestHooks: Sendable {
    public var dataDirectory: URL
    public var authenticator: ScriptedAuthenticator
    public var lockSeed: String?
    public var gatewaySeeds: [(name: String, address: String)]
    public var traceLaunch: Bool
    public var openSettings: Bool
    public var openURL: String?

    public init?(arguments: [String]) {
      func values(_ flag: String) -> [String] {
        arguments.indices.compactMap { index in
          arguments[index] == flag && arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
        }
      }

      func isOn(_ flag: String) -> Bool {
        values(flag).last.map { ["YES", "1", "true"].contains($0) } ?? false
      }

      guard isOn("-HermieUITest") else {
        return nil
      }

      let verdicts: [AuthenticationVerdict] = (values("-HermieFakeAuth").last ?? "ok")
        .split(separator: ",")
        .map { word in
          switch word.trimmingCharacters(in: .whitespaces) {
          case "ok": .ok
          case "unavailable": .unavailable
          default: .failed
          }
        }

      let enrolment: DeviceEnrolment =
        switch values("-HermieFakeEnrolment").last {
        case "passcode": .passcode
        case "none": .none
        case "unavailable": .unavailable
        default: .biometric
        }

      if let directory = values("-HermieDataDirectory").last {
        dataDirectory = URL(fileURLWithPath: directory, isDirectory: true)
      } else {
        dataDirectory = FileManager.default.temporaryDirectory
          .appendingPathComponent("hermie-ui-test-\(UUID().uuidString)", isDirectory: true)
      }

      authenticator = ScriptedAuthenticator(enrolment: enrolment, verdicts: verdicts)
      lockSeed = values("-HermieSeedLock").last
      gatewaySeeds = values("-HermieSeedGateway").compactMap { value in
        let parts = value.split(separator: "|", maxSplits: 1).map(String.init)

        return parts.count == 2 ? (parts[0], parts[1]) : nil
      }
      traceLaunch = isOn("-HermieLaunchTrace")
      openSettings = isOn("-HermieOpenSettings")
      openURL = values("-HermieOpenURL").last
    }

    /// Write the seeds, before the lock or the registry is read.
    func seed(_ keyValues: KeyValueStore) async {
      if let lockSeed {
        try? await keyValues.setString(lockSeed, forKey: StoreKeys.lock)
      }

      let registry = GatewayRegistryStore(store: keyValues.store)

      for (offset, seed) in gatewaySeeds.enumerated() {
        let record = GatewayRecord(
          id: GatewayRegistry.newGatewayId(),
          name: seed.name,
          address: seed.address,
          authKind: .sessionToken,
          addedAt: Double(1_700_000_000_000 + offset)
        )

        _ = try? await registry.add(record)
      }
    }
  }
#endif
