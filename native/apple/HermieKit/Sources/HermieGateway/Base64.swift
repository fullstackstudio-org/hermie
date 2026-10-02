import Foundation

/// Base64 from raw bytes (the port of `base64.ts`), standard alphabet with `=` padding.
///
/// The reference spells the encoder out because Hermes has no `btoa` for
/// arbitrary bytes; Foundation's encoder writes the same RFC 4648 text, so the
/// port uses it.
public enum Base64 {
  public static func encode(_ bytes: [UInt8]) -> String {
    Data(bytes).base64EncodedString()
  }

  /// base64url without padding (RFC 7636 §4): `+` → `-`, `/` → `_`, trailing `=` dropped.
  public static func encodeURL(_ bytes: [UInt8]) -> String {
    var text = encode(bytes)

    while text.hasSuffix("=") {
      text.removeLast()
    }

    return String(text.map { $0 == "+" ? "-" : $0 == "/" ? "_" : $0 })
  }
}
