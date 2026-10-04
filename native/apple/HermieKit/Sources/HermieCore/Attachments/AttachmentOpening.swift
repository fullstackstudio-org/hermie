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
 */
public enum AttachmentOpening {
  /// What `reference` can be opened as. `fileExists` is asked about an absolute path.
  public static func target(
    for reference: String,
    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) -> AttachmentTarget {
    let value = unwrapped(reference)
    let name = displayName(value)

    if let path = gatewayFilePath(value) {
      return .gatewayFile(path: path, name: name)
    }

    if value.hasPrefix("/"), !value.contains("\0"), fileExists(value) {
      return .localFile(URL(fileURLWithPath: value))
    }

    return .unavailable(name: name)
  }

  /// Where opened copies of the gateway's files are kept: the caches, never backed up, one folder
  /// per file so two of one name do not meet.
  public static var directory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("hermie-opened", isDirectory: true)
  }

  /// Write a fetched file where Quick Look can read it.
  static func keep(_ data: Data, name: String) throws -> URL {
    let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
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
    switch AttachmentOpening.target(for: reference, fileExists: fileExists) {
    case .localFile(let url):
      return .preview(url)
    case .unavailable(let name):
      return .unavailable(name: name)
    case .gatewayFile(let path, let name):
      guard let data = await link.fetchFile(path), let url = try? AttachmentOpening.keep(data, name: name) else {
        return .failed(name: name)
      }

      return .preview(url)
    }
  }
}
