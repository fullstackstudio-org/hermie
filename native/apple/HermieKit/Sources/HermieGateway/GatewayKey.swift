/// A name for a gateway that two programs can arrive at independently: the
/// port of `gateway-key.ts`.
///
/// **FNV-1a, 64-bit, over the UTF-8 bytes of the origin**, printed as 16
/// lowercase hex digits. The origin and not the address, so a path prefix does
/// not change the key. It is not a secret and not a security boundary.
public enum GatewayKey {
  private static let offset: UInt64 = 0xCBF2_9CE4_8422_2325
  private static let prime: UInt64 = 0x0000_0100_0000_01B3

  /// FNV-1a over the UTF-8 bytes, as 16 lowercase hex digits.
  public static func fnv1a64(_ input: String) -> String {
    var hash = offset

    for byte in input.utf8 {
      hash = (hash ^ UInt64(byte)) &* prime
    }

    let hex = String(hash, radix: 16)
    return String(repeating: "0", count: 16 - hex.count) + hex
  }

  /// The key for one gateway address, or `""` when it is not an address.
  ///
  /// An address with an opaque origin (`mailto:`, `file:`, `example.com:9119`
  /// read as scheme `example.com`) has the origin `"null"`, shared by every
  /// such address, so it names no gateway and keys as `""` too.
  public static func of(_ address: String) -> String {
    let origin = GatewayAddress.origin(of: address)
    return origin.isEmpty || origin == "null" ? "" : fnv1a64(origin)
  }

  /// True for a string `of` could have produced (`/^[0-9a-f]{16}$/u`). Keys arrive from the wire.
  public static func isValid(_ value: String?) -> Bool {
    guard let value else {
      return false
    }

    return value.unicodeScalars.count == 16
      && value.unicodeScalars.allSatisfy { JSText.isASCIIDigit($0) || ("a"..."f").contains($0) }
  }
}
