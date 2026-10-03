import Foundation

/// What the gateway accepts as an attachment, and how one is named and addressed: the rules of
/// `attachments.ts` and `file-upload.ts` in the web client, in one place and without a view in it.
///
/// ## Two roads to the gateway
///
/// - **An image** goes as base64 over the socket (`image.attach_bytes`), by its file name's
///   extension, up to 25 MiB (`maxImageBytes`). It is never named in the prompt: the gateway writes
///   its own `@image:` reference into the row it keeps.
/// - **Anything else** is uploaded over HTTP when it is staged (`POST /api/files/upload-stream`, up
///   to 100 MiB) to `<cwd>/uploads/hermie/<date>/<token>-<name>` and named in the prompt by its
///   `@file:` reference. An SVG or an icon is a file: a vision model reads neither, and an SVG is
///   text the agent can read. A HEIC photograph is a file too: the gateway has no extension for it.
public enum AttachmentRules {
  /// `_ATTACH_BYTES_MAX_BYTES` in `tui_gateway/prompt_attachments.py`: the cap of `image.attach_bytes`.
  public static let maxImageBytes = 25 * 1024 * 1024

  /// `_MANAGED_FILE_MAX_BYTES` in `hermes_cli/web_server.py`: the cap of the upload route.
  public static let maxFileBytes = 100 * 1024 * 1024

  /// The largest image drawn as its own thumbnail; a larger one shows the file glyph.
  public static let maxPreviewBytes = 8 * 1024 * 1024

  /// The extensions an image keeps the image road with: the gateway's own list minus `.svg` and `.ico`.
  public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"]

  /// The extension a nameless image (a paste, a screenshot) is given, from its type.
  static let extensionForType: [String: String] = [
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff"
  ]

  /// The type a file with no known one is sent under.
  public static let fallbackType = "application/octet-stream"

  /// `png` of `shot.PNG`; empty for a name with no extension.
  static func fileExtension(of name: String) -> String {
    let base = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""

    guard let dot = base.lastIndex(of: "."), dot != base.startIndex else {
      return ""
    }

    return String(base[base.index(after: dot)...]).lowercased()
  }

  /// The name an image is attached under, or nil when the file takes the file road. The gateway
  /// reads the image's format off this name, so a nameless paste is given the extension of its type
  /// rather than left to the gateway's guess (`imageNameFor`).
  public static func imageName(for name: String, mimeType: String?) -> String? {
    let type = mimeType?.lowercased() ?? ""
    let ext = fileExtension(of: name)

    if !ext.isEmpty {
      return imageExtensions.contains(ext) && (type.isEmpty || type.hasPrefix("image/")) ? name : nil
    }

    guard let given = extensionForType[type] else {
      return nil
    }

    let base = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(base.isEmpty ? "image" : base).\(given)"
  }

  /// The most the road a file takes accepts: 25 MiB for an image, 100 MiB for anything else.
  public static func cap(forName name: String, mimeType: String?) -> Int {
    imageName(for: name, mimeType: mimeType) == nil ? maxFileBytes : maxImageBytes
  }

  /// A file name that cannot mean anything but itself: path separators, `..`, control characters
  /// and leading dots are removed rather than escaped (`sanitiseUploadName`).
  public static func sanitisedName(_ name: String) -> String {
    let base = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
    var cleaned = ""
    var pendingJoin = false

    // Anything outside [A-Za-z0-9._-] (and every control character) becomes one hyphen per run.
    for scalar in base.unicodeScalars {
      let plain =
        (scalar.value >= 0x30 && scalar.value <= 0x39) || (scalar.value >= 0x41 && scalar.value <= 0x5A)
        || (scalar.value >= 0x61 && scalar.value <= 0x7A) || scalar == "." || scalar == "_" || scalar == "-"

      if plain {
        pendingJoin = false
        cleaned.unicodeScalars.append(scalar)
      } else if !pendingJoin {
        pendingJoin = true
        cleaned += "-"
      }
    }

    // Leading dots and hyphens go; runs of hyphens collapse; 80 characters at most.
    while let first = cleaned.first, first == "." || first == "-" {
      cleaned.removeFirst()
    }

    var collapsed = ""

    for character in cleaned {
      if character == "-", collapsed.last == "-" {
        continue
      }

      collapsed.append(character)
    }

    let limited = String(collapsed.prefix(80))
    return limited.isEmpty ? "attachment" : limited
  }

  /// `<cwd>/uploads/hermie/<yyyy-mm-dd>/<token>-<name>`: under the session's own working directory,
  /// because nowhere else satisfies both the upload (an absolute path) and the reference (the
  /// gateway reads `@file:` only inside the workspace). Nil when there is no workspace to put it
  /// in: no directory, or `/` alone, which would be the root of the gateway's machine.
  public static func uploadPath(cwd: String?, name: String, now: Date = Date(), token: String? = nil) -> String? {
    guard var root = cwd else {
      return nil
    }

    while root.hasSuffix("/") {
      root.removeLast()
    }

    guard !root.isEmpty else {
      return nil
    }

    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)

    return "\(root)/uploads/hermie/\(formatter.string(from: now))/\(token ?? randomToken())-\(sanitisedName(name))"
  }

  /// Eight base-36 characters: two uploads of one name on one day cannot collide.
  static func randomToken() -> String {
    let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    return String((0..<8).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
  }

  /// The token the gateway expands into the file's contents; backticks when the path holds whitespace.
  public static func fileReference(path: String) -> String {
    path.rangeOfCharacter(from: .whitespacesAndNewlines) != nil ? "@file:`\(path)`" : "@file:\(path)"
  }

  /// An attached image's reference with only the name in the path position: what the bubble holds
  /// until the gateway's own row lands, so the two are recognised as one send.
  public static func imageReference(name: String) -> String {
    name.rangeOfCharacter(from: .whitespacesAndNewlines) != nil ? "@image:`\(name)`" : "@image:\(name)"
  }

  /// The prompt as it goes to the gateway: the reader's words, then the references.
  public static func withFileReferences(_ text: String, paths: [String]) -> String {
    guard !paths.isEmpty else {
      return text
    }

    let references = paths.map(fileReference(path:)).joined(separator: "\n")
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)

    return body.isEmpty ? references : "\(body)\n\n\(references)"
  }
}

/// One attachment ready to leave with a message: an image's bytes, or a file already on the gateway.
public enum OutgoingAttachment: Sendable, Equatable {
  /// Goes over the socket as `image.attach_bytes`, under `filename`.
  case image(filename: String, base64: String)
  /// Already uploaded; only its absolute path on the gateway travels, in the prompt.
  case file(filename: String, path: String)

  public var filename: String {
    switch self {
    case .image(let filename, _), .file(let filename, _): filename
    }
  }

  /// What the painted bubble records (`UserItem.attachments`): the same `@file:` / `@image:` strings
  /// the gateway's row will carry.
  public var reference: String {
    switch self {
    case .image(let filename, _): AttachmentRules.imageReference(name: filename)
    case .file(_, let path): AttachmentRules.fileReference(path: path)
    }
  }

  /// The path an uploaded file is named by in the prompt, nil for an image.
  public var filePath: String? {
    if case .file(_, let path) = self { path } else { nil }
  }
}
