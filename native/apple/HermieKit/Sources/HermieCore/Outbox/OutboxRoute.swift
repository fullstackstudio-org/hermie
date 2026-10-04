import Foundation
import HermieTranscript

/// Where a file a bot shared is asked for, and how much of it this device takes (`contract/outbox/` §4).
public enum OutboxRoute {
  /// `GET /api/files/outbox/<id>/<name>` with `?profile=<handle>`, exactly as the picture and upload routes
  /// name a bot's profile. The address is built from the attachment's validated token and name
  /// (`OutboxAttachment.encodedName`), never from its `url` as it arrived: what is asked for is always a place on
  /// the outbox route, whatever a sender put in `url`. A handle is added here and never anything else, and never a
  /// token.
  public static func path(for attachment: OutboxAttachment, profile: String?) -> String {
    let route = "/api/files/outbox/\(attachment.id)/\(OutboxAttachment.encodedName(attachment.name))"
    guard let profile, !profile.isEmpty else { return route }
    return "\(route)?profile=\(queryValue(profile))"
  }

  /// `encodeURIComponent`: everything but the unreserved characters is percent-encoded.
  static func queryValue(_ value: String) -> String {
    var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    allowed.insert(charactersIn: "-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
  }
}

/// How much of a shared file is taken, by kind: enforced while the bytes arrive, not trusted from a header.
public enum OutboxLimits {
  /// A picture is drawn from a file this size at most.
  public static let imageBytes = 25 * 1024 * 1024
  /// A video, a sound, a PDF or any other file (the gateway shares nothing larger).
  public static let fileBytes = 200 * 1024 * 1024
  /// A PDF this small is fetched when its card appears, for its page count; a larger one when it is opened.
  public static let pdfPrefetchBytes = 4 * 1024 * 1024

  public static func maxBytes(for kind: OutboxKind) -> Int {
    kind == .image ? imageBytes : fileBytes
  }

  /// Whether a file of this size and kind is within what this device takes.
  public static func allows(_ attachment: OutboxAttachment) -> Bool {
    attachment.size <= maxBytes(for: attachment.kind)
  }
}
