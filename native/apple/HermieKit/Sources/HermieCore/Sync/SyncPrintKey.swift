import CryptoKit
import Foundation
import HermieStore

/**
 This device's sync identity, both halves in the device-only keychain (`AfterFirstUnlockThisDeviceOnly`,
 never synced), so they are lost together (review A5):

 - `hermie.sync.print_key`: 32 random bytes. A print is HMAC-SHA-256 of a value's canonical text
   under it, truncated to 16 bytes, base64. Nothing in SQLite can be turned back into a secret
   without the key, and the key never leaves the device.
 - `hermie.sync.device`: the 8-hex device tag every stamp of this device carries.

 Minted once. When the key is gone (a keychain reset, an iCloud backup restored onto another
 device, where SQLite comes back and device-only items do not) a new key AND a new device tag are
 minted and the log says so; the merge then sees `SyncState.printCheck` fail and voids every stored
 print. The same happens when the key is there but the state's print check names another key (a
 state from somewhere else). A key that exists but cannot be read is never replaced: the read
 throws and the reconcile is aborted. A reinstall on iOS keeps keychain items: with no state row
 and a key present, the key and the tag are kept (review A8).
 */
public enum SyncPrintKey {
  public static let storageKey = "hermie.sync.print_key"
  public static let deviceKey = "hermie.sync.device"
  static let byteCount = 32
  static let printBytes = 16

  struct Identity {
    let key: SymmetricKey
    let device: String
    let mintedKey: Bool
    let mintedDevice: Bool
    /// The stored key was there but not one this build can read; it was replaced.
    let replacedUnreadableKey: Bool

    var printer: SyncPrinter { SyncPrintKey.printer(key: key) }
  }

  /// Whether a print key is stored (for the reinstall check). Throws like `get`.
  static func exists(in store: any SecretStore) throws -> Bool {
    try store.get(storageKey) != nil
  }

  /// Read the key and the tag, minting what is missing. Throws on any read or write failure: a
  /// key or tag that cannot be stored must not be used, or the next run would see prints and
  /// stamps from something nobody kept.
  static func load(
    from store: any SecretStore,
    stateDevice: String?,
    stateCheck: String?,
    randomBytes: (Int) -> [UInt8]
  ) throws -> Identity {
    let storedKey = try store.get(storageKey)
    let storedDevice = try store.get(deviceKey)

    func mintDevice() throws -> String {
      let bytes = randomBytes(4)
      guard bytes.count == 4 else { throw SyncEngineError.randomUnavailable }
      let device = bytes.map { String(format: "%02x", $0) }.joined()
      try store.set(deviceKey, device)
      return device
    }

    if let storedKey, let data = Data(base64Encoded: storedKey), data.count == byteCount {
      let key = SymmetricKey(data: data)

      if let stateCheck, stateCheck != printer(key: key).check {
        // The state was made under another key: it is not this device's. A tag of its own.
        return Identity(key: key, device: try mintDevice(), mintedKey: false, mintedDevice: true, replacedUnreadableKey: false)
      }

      if let storedDevice, SyncState.isValidDevice(storedDevice) {
        return Identity(key: key, device: storedDevice, mintedKey: false, mintedDevice: false, replacedUnreadableKey: false)
      }

      if let stateDevice, SyncState.isValidDevice(stateDevice) {
        try store.set(deviceKey, stateDevice)
        return Identity(key: key, device: stateDevice, mintedKey: false, mintedDevice: false, replacedUnreadableKey: false)
      }

      return Identity(key: key, device: try mintDevice(), mintedKey: false, mintedDevice: true, replacedUnreadableKey: false)
    }

    // No key (or one this build cannot read): a new tag first, then the key, so a crash between
    // the two leaves no key and the next run mints both again.
    let device = try mintDevice()
    let bytes = randomBytes(byteCount)

    guard bytes.count == byteCount else {
      throw SyncEngineError.randomUnavailable
    }

    try store.set(storageKey, Data(bytes).base64EncodedString())

    return Identity(
      key: SymmetricKey(data: Data(bytes)), device: device, mintedKey: true, mintedDevice: true,
      replacedUnreadableKey: storedKey != nil)
  }

  /// The printer for a key: HMAC-SHA-256, truncated to 16 bytes, base64.
  static func printer(key: SymmetricKey) -> SyncPrinter {
    SyncPrinter { text in
      let mac = HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: key)
      return Data(mac.prefix(printBytes)).base64EncodedString()
    }
  }
}
