import Foundation

/// Where an attachment a message names can be opened from.
public enum AttachmentTarget: Sendable, Equatable {
  /// A file on this device (a gateway on this Mac names its own disk).
  case localFile(URL)
  /// A file the gateway serves (`/api/files/…`, what an agent writes into a reply): fetched with
  /// the gateway's own credentials, never from anywhere else.
  case gatewayFile(path: String, name: String)
  /// Only on the gateway's disk, which this device cannot read: nothing to open here.
  case unavailable(name: String)
}

/**
 Turning a message's attachment reference (`@file:/home/…/report.pdf`, `@image:"chart.png"`, a
 `/api/files/…` path) into something this device can open, or saying honestly that it cannot.

 The gateway has no route that serves an arbitrary path of its disk, so a `@file:` reference to one
 is not something this app can fetch: it opens a file this device has (the same Mac as the
 gateway), a file the gateway serves under `/api/files/`, and nothing else. A path that tries to
 leave `/api/files/` (`..`, an encoded dot, a backslash) is refused, as the web client refuses it.

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

    return .unavailable(name: name)
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
    let url = folder.appendingPathComponent(AttachmentRules.sanitisedName(name.isEmpty ? "file" : name))
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
  public func prepareAttachment(
    _ reference: String,
    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) async -> AttachmentOpenResult {
    let localFiles = AttachmentOpening.isLoopback(link.gatewayAddress)

    switch AttachmentOpening.target(for: reference, localFiles: localFiles, fileExists: fileExists) {
    case .localFile(let url):
      return .preview(url)
    case .unavailable(let name):
      return .unavailable(name: name)
    case .gatewayFile(let path, let name):
      guard let data = await link.fetchFile(path), let url = try? AttachmentOpening.keep(data, name: name, gateway: gatewayID) else {
        return .failed(name: name)
      }

      return .preview(url)
    }
  }
}
