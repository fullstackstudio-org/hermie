import Foundation
import HermieTranscript

/// Where an attachment a message names can be opened from.
public enum AttachmentTarget: Sendable, Equatable {
  /// A file on this device (a gateway on this Mac names its own disk).
  case localFile(URL)
  /// A file the gateway serves (`/api/files/…`, what an agent writes into a reply): fetched with
  /// the gateway's own credentials, never from anywhere else.
  case gatewayFile(path: String, name: String)
  /// An absolute path on the gateway's own disk (an upload, a screenshot the agent took): asked for
  /// through the gateway's managed-files route, which serves what its own policy allows and refuses the
  /// rest.
  case gatewayDisk(path: String, name: String)
  /// A name with nothing to fetch it by (a bare file name, a web address): nothing to open here.
  case unavailable(name: String)
}

/**
 Turning a message's attachment reference (`@file:/home/…/report.pdf`, `@image:"chart.png"`, a
 `/api/files/…` path) into something this device can open, or saying honestly that it cannot.

 The gateway has no route that serves an arbitrary path of its disk, so a `@file:` reference to one
 is not something this app can fetch: it opens a file this device has (the same Mac as the
 gateway), a file the gateway serves under `/api/files/`, and nothing else. A path that tries to
 leave `/api/files/` (`..`, an encoded dot, a backslash) is refused, as the web client refuses it.

 A picture an image attached to a chat names by the gateway's own `images/` folder has a third, narrower
 route that works where the managed-files root is locked: `GET /api/files/images/<name>?profile=<profile>`
 (`attachedImagePath`). It is asked FIRST, and only for a path whose folder is that profile's `images/` folder
 (never the file name of some other path: a file of that name there would be a different picture); the two
 routes above are what is left for every other path, and for a gateway that does not have it.

 A path on this device's disk is opened only when the gateway runs on this device (it is dialled at
 a loopback address): then the path names a file of the gateway's own, which is also this device's.
 For any other gateway the same path would name a file of this device that the gateway knows
 nothing about, and a message must not be a way to put, say, a private key on screen.
 */
public enum AttachmentOpening {
  /// What `reference` can be opened as. `localFiles`: a path on this device's disk may be opened (the
  /// gateway is this device). `fileExists` is asked about an absolute path.
  public static func target(
    for reference: String,
    localFiles: Bool,
    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) -> AttachmentTarget {
    let value = unwrapped(reference)
    let name = displayName(value)

    if let path = gatewayFilePath(value) {
      return .gatewayFile(path: path, name: name)
    }

    if localFiles, value.hasPrefix("/"), !value.contains("\0"), fileExists(value) {
      return .localFile(URL(fileURLWithPath: value))
    }

    if let path = gatewayDiskPath(value) {
      return .gatewayDisk(path: path, name: name)
    }

    return .unavailable(name: name)
  }

  /// `GET /api/files/download?path=…`: the managed-files route, which serves a file by its absolute
  /// path on the gateway's disk (the place an upload went to) and answers 4xx for what its policy keeps.
  public static func managedDownloadPath(_ path: String) -> String {
    "/api/files/download?path=\(queryValue(path))"
  }

  /// `GET /api/media?path=…`: the gateway's picture route (a JSON `data_url` for an image under its
  /// images, screenshots and cache folders).
  public static func mediaPath(_ path: String) -> String {
    "/api/media?path=\(queryValue(path))"
  }

  /// What `get_attached_image` serves: a name of one path component with one of these suffixes.
  private static let attachedImageSuffixes: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp"]

  /// `GET /api/files/images/<name>?profile=<profile>` for `reference`, or nil when its path is not one of
  /// `profile`'s own attached images.
  ///
  /// An attached image is written to `<profile home>/images/<file>`, and the home is `<HERMES_HOME>` for the
  /// default profile (`default`) or `<HERMES_HOME>/profiles/<name>` for any other. The client cannot see the
  /// disk, so it reads the shape and refuses anything it cannot be sure of:
  ///
  /// - the path is absolute, whole (no `.`/`..`, no empty or backslash part, no `?`, `#` or `%`) and ends
  ///   `images/<file>`, the file being a name the route serves (one component, an image suffix of the six);
  /// - for `default`, no part of the folder above `images` is `profiles` (that is another profile's), and it is
  ///   not itself called `images` (`<home>/images/images/<file>` is not `<home>/images/<file>`);
  /// - for any other profile, the folder above `images` is `profiles/<that profile>`, so a path in the
  ///   default profile's folder, or in another profile's, is refused.
  public static func attachedImagePath(_ reference: String, profile: String) -> String? {
    let value = unwrapped(reference)

    // `/api/files/…` is what the gateway itself serves (asked as it is), never a place on its disk.
    guard isProfileName(profile), value.hasPrefix("/"), !value.hasPrefix("//"), !value.hasPrefix("/api/files/"),
      !value.contains(where: { $0 == "\\" || $0 == "\0" || $0 == "?" || $0 == "#" || $0 == "%" })
    else {
      return nil
    }

    let parts = value.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)

    guard parts.count >= 3, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
      parts[parts.count - 2] == "images", let file = parts.last, isAttachedImageName(file)
    else {
      return nil
    }

    let home = parts.dropLast(2)
    let own: Bool

    if profile == "default" {
      own = !home.contains("profiles") && home.last != "images"
    } else {
      own = home.count >= 2 && home[home.endIndex - 2] == "profiles" && home[home.endIndex - 1] == profile
    }

    guard own else {
      return nil
    }

    return "/api/files/images/\(file)?profile=\(profile)"
  }

  /// `[a-z0-9][a-z0-9_-]{0,63}`: what the gateway takes as a profile name, so nothing else goes in an address.
  private static func isProfileName(_ name: String) -> Bool {
    guard (1...64).contains(name.utf8.count), let first = name.utf8.first, isLowerAlnum(first) else { return false }
    return name.utf8.allSatisfy { isLowerAlnum($0) || $0 == UInt8(ascii: "_") || $0 == UInt8(ascii: "-") }
  }

  private static func isLowerAlnum(_ byte: UInt8) -> Bool {
    (byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z")) || (byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9"))
  }

  /// `[A-Za-z0-9][A-Za-z0-9._-]{0,254}`, no `..`, one of the six image suffixes.
  private static func isAttachedImageName(_ name: String) -> Bool {
    let bytes = Array(name.utf8)

    guard (1...255).contains(bytes.count), let first = bytes.first,
      isLowerAlnum(first) || (first >= UInt8(ascii: "A") && first <= UInt8(ascii: "Z")),
      bytes.allSatisfy({
        isLowerAlnum($0) || ($0 >= UInt8(ascii: "A") && $0 <= UInt8(ascii: "Z")) || $0 == UInt8(ascii: ".")
          || $0 == UInt8(ascii: "_") || $0 == UInt8(ascii: "-")
      }), !name.contains(".."), let dot = name.lastIndex(of: "."), dot != name.startIndex
    else {
      return false
    }

    return attachedImageSuffixes.contains(name[name.index(after: dot)...].lowercased())
  }

  private static func queryValue(_ path: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~/")
    return path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
  }

  /// An absolute path to ask the gateway for: not a web address, with no `..` or `.` segment, no
  /// backslash and no NUL. What the gateway then allows is its own policy.
  static func gatewayDiskPath(_ value: String) -> String? {
    guard value.hasPrefix("/"), !value.hasPrefix("//"), value.count > 1, !value.contains("\0"), !value.contains("\\") else {
      return nil
    }

    let segments = value.split(separator: "/", omittingEmptySubsequences: true)
    guard !segments.isEmpty, !segments.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
    return value
  }

  /// The pictures a `/api/media` answer can be, by extension.
  static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff"]

  /// Whether `name` ends in a picture's extension.
  public static func hasImageExtension(_ name: String) -> Bool {
    guard let dot = name.lastIndex(of: "."), name.index(after: dot) < name.endIndex else { return false }
    return imageExtensions.contains(name[name.index(after: dot)...].lowercased())
  }

  /// The image bytes inside a `/api/media` answer (`{"data_url": "data:image/png;base64,…"}`), or nil.
  static func imageData(inMediaAnswer data: Data) -> Data? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let url = object["data_url"] as? String, url.hasPrefix("data:"), let comma = url.firstIndex(of: ",")
    else { return nil }

    return Data(base64Encoded: String(url[url.index(after: comma)...]))
  }

  /// The extension a picture's own first bytes call for, or nil when they are not one of the five.
  public static func sniffedExtension(_ data: Data) -> String? {
    switch sniffImageType([UInt8](data.prefix(32))) {
    case "image/png": "png"
    case "image/jpeg": "jpg"
    case "image/gif": "gif"
    case "image/webp": "webp"
    case "image/heic": "heic"
    default: nil
    }
  }

  /// Whether `address` dials this device itself: `localhost` (or a name under it), `127.0.0.0/8`,
  /// `::1`.
  public static func isLoopback(_ address: String?) -> Bool {
    guard let address, let host = URLComponents(string: address)?.host?.lowercased() else {
      return false
    }

    let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))

    if bare == "localhost" || bare.hasSuffix(".localhost") || bare == "::1" {
      return true
    }

    // A real IPv4 address in 127.0.0.0/8: four decimal labels of 0 to 255, never a name that starts
    // with "127.".
    let labels = bare.split(separator: ".", omittingEmptySubsequences: false)

    guard labels.count == 4, labels.first == "127" else {
      return false
    }

    return labels.allSatisfy { label in
      !label.isEmpty && label.count <= 3 && label.allSatisfy { $0.isASCII && $0.isNumber } && Int(label).map { $0 <= 255 } == true
    }
  }

  /// Delete every copy of one gateway's files that was opened: on signing out of it and when it is
  /// removed, never on a reconnect or a switch (Quick Look may still be showing one).
  public static func discardOpened(gateway: String) {
    try? FileManager.default.removeItem(at: directory(gateway: gateway))
  }

  /// Where opened copies of the gateway's files are kept: the temporary directory, never backed up,
  /// a folder per gateway and one per file so two of one name do not meet.
  public static var directory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("hermie-opened", isDirectory: true)
  }

  static func directory(gateway: String) -> URL {
    directory.appendingPathComponent(AttachmentRules.sanitisedName(gateway.isEmpty ? "gateway" : gateway), isDirectory: true)
  }

  /// Write a fetched file where Quick Look can read it.
  static func keep(_ data: Data, name: String, gateway: String) throws -> URL {
    let folder = directory(gateway: gateway).appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var fileName = AttachmentRules.sanitisedName(name.isEmpty ? "file" : name)
    // A file with no (or no picture) extension that is a picture by its first bytes gets the extension
    // Quick Look and the gallery go by: an image dropped from a screenshot tool has none.
    if !hasImageExtension(fileName), let ext = sniffedExtension(data) { fileName += ".\(ext)" }
    let url = folder.appendingPathComponent(fileName)
    try data.write(to: url, options: .atomic)
    return url
  }

  /// The reference without its `@file:` / `@image:` marker and its quotes.
  static func unwrapped(_ reference: String) -> String {
    var value = Substring(reference.trimmingCharacters(in: .whitespacesAndNewlines))

    for prefix in ["@file:", "@image:"] where value.hasPrefix(prefix) {
      value = value.dropFirst(prefix.count)
      break
    }

    let quotes: Set<Character> = ["\"", "'", "`"]

    if let first = value.first, quotes.contains(first) {
      value = value.dropFirst()
    }

    if let last = value.last, quotes.contains(last) {
      value = value.dropLast()
    }

    return String(value)
  }

  /// The file's own name, for the notice and the preview's title.
  static func displayName(_ value: String) -> String {
    let name = value.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? value
    return name.isEmpty ? value : name
  }

  /// `/api/files/…` (or `api/files/…`) as the gateway-relative path to fetch, or nil when it is not
  /// one, or tries to leave the folder.
  static func gatewayFilePath(_ value: String) -> String? {
    let path = value.hasPrefix("/") ? value : "/" + value

    guard path.hasPrefix("/api/files/"), path.count > "/api/files/".count else {
      return nil
    }

    let lowered = path.lowercased()

    guard !path.contains("\\"), !path.contains("\0"), !lowered.contains("%2e"), !lowered.contains("%2f"),
      !lowered.contains("%5c")
    else {
      return nil
    }

    let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()

    guard !segments.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }) else {
      return nil
    }

    return path
  }
}

/// What opening an attachment came to.
public enum AttachmentOpenResult: Sendable, Equatable {
  /// A file on this device to preview (Quick Look).
  case preview(URL)
  /// It is only on the gateway's disk: nothing on this device can open it.
  case unavailable(name: String)
  /// The gateway serves it, but it could not be fetched (refused, gone, unreachable).
  case failed(name: String)
}

extension GatewaySession {
  /// Make an attachment a message names ready to open: a file this device has, or one the gateway
  /// serves, fetched through this session's own credentials (`AttachmentOpening`).
  ///
  /// `profile` is the chat's own: it says which `images/` folder an attached picture's path may be asked for
  /// from the gateway's attached-image route (`AttachmentOpening.attachedImagePath`).
  public func prepareAttachment(
    _ reference: String,
    profile: String? = nil,
    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) async -> AttachmentOpenResult {
    let localFiles = AttachmentOpening.isLoopback(link.gatewayAddress)

    switch AttachmentOpening.target(for: reference, localFiles: localFiles, fileExists: fileExists) {
    case .localFile(let url):
      return .preview(url)
    case .unavailable(let name):
      return .unavailable(name: name)
    case .gatewayDisk(let path, let name):
      // An image attached to this chat, in its profile's own images folder: the gateway's own route for
      // exactly that, which a locked managed-files root does not close.
      if let profile, let route = AttachmentOpening.attachedImagePath(reference, profile: profile),
        let data = await link.fetchFile(route),
        let url = try? AttachmentOpening.keep(data, name: name, gateway: gatewayID)
      {
        return .preview(url)
      }

      // The upload (or the agent's file) is on the gateway's disk: its managed-files route serves it
      // when its policy allows, and its picture route serves an image under its images folders.
      if let data = await link.fetchFile(AttachmentOpening.managedDownloadPath(path)),
        let url = try? AttachmentOpening.keep(data, name: name, gateway: gatewayID)
      {
        return .preview(url)
      }

      if AttachmentOpening.hasImageExtension(name),
        let answer = await link.fetchFile(AttachmentOpening.mediaPath(path)),
        let data = AttachmentOpening.imageData(inMediaAnswer: answer),
        let url = try? AttachmentOpening.keep(data, name: name, gateway: gatewayID)
      {
        return .preview(url)
      }

      return .failed(name: name)
    case .gatewayFile(let path, let name):
      guard let data = await link.fetchFile(path), let url = try? AttachmentOpening.keep(data, name: name, gateway: gatewayID) else {
        return .failed(name: name)
      }

      return .preview(url)
    }
  }
}
