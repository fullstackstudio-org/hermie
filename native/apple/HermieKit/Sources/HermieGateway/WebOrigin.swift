import Foundation

/// The two things `new URL(value)` answers that callers outside this target need: the scheme and
/// the origin, exactly as the URL Standard serialises them (`WHATWGURL`).
public enum WebOrigin {
  /// `url.protocol` without its colon and `url.origin`, or nil where `new URL(value)` throws.
  public static func parse(_ value: String) -> (scheme: String, host: String, origin: String)? {
    guard let url = WHATWGURL.parse(value) else {
      return nil
    }

    return (url.scheme, url.host ?? "", url.origin)
  }
}
