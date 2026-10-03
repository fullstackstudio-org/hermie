import Foundation
import HermieGateway
import Observation

/// A file the reader picked, on this device, ready to be read: a copy the app owns (a picked file is
/// only readable inside its security scope, so the view copies it out before it hands it over).
public struct PickedFile: Sendable, Equatable {
  /// The file's own name: what the reader picked.
  public var name: String
  /// Its type, when one is known (`image/png`).
  public var mimeType: String?
  public var size: Int
  /// Where the app's copy is. The tray removes it when the attachment is gone.
  public var url: URL

  public init(name: String, mimeType: String? = nil, size: Int, url: URL) {
    self.name = name
    self.mimeType = mimeType
    self.size = size
    self.url = url
  }
}

/// Why a chip did not become ready.
public enum AttachmentProblem: Sendable, Equatable {
  /// Over the cap of the road it takes: caught before any byte moves, or the gateway's 413.
  case tooLarge(limitBytes: Int)
  /// The chat has not told us its working directory, so there is nowhere a file would be readable.
  case noWorkspace
  /// The gateway answered and said no; `detail` is its own words.
  case refused(detail: String)
  /// The upload did not complete: the network, a proxy, a 5xx.
  case failed(message: String)
  /// The file could not be read from this device.
  case unreadable(message: String)

  /// A retry would be refused the same way.
  var retryable: Bool {
    if case .tooLarge = self { false } else { true }
  }

  /// The problem a failed upload came to. Cancellation is not one: the reader asked for it.
  static func of(_ error: any Error) -> AttachmentProblem {
    if let error = error as? AttachmentUploadError {
      switch error {
      case .noWorkspace: return .noWorkspace
      }
    }

    if let error = error as? GatewayError {
      if error.status == 413 {
        return .tooLarge(limitBytes: AttachmentRules.maxFileBytes)
      }

      switch error.kind {
      case .auth, .protocol, .redirect, .notHermes, .incompatible:
        return .refused(detail: error.hint ?? error.message)
      default:
        return .failed(message: error.message)
      }
    }

    return .failed(message: (error as NSError).localizedDescription)
  }
}

/// A refusal of the app's own, before a byte moves.
public enum AttachmentUploadError: Error, Sendable, Equatable {
  /// The session never reported a working directory (or reported `/`).
  case noWorkspace
}

public enum AttachmentKind: Sendable, Equatable {
  case image
  case file
}

public enum AttachmentStatus: Sendable, Equatable {
  case working
  case ready
  case failed
}

/// One chip of the tray, as the screen draws it.
public struct StagedAttachment: Sendable, Equatable, Identifiable {
  public var id: String
  public var kind: AttachmentKind
  /// The file's own name.
  public var name: String
  public var size: Int
  public var status: AttachmentStatus
  public var problem: AttachmentProblem?
  /// How much of an upload has gone, 0 to 1; nil for an image (read, not uploaded) or before it starts.
  public var progress: Double?
  /// Where a ready image can be drawn from, when it is small enough to show as its own thumbnail.
  public var previewURL: URL?
}

/// What the composer has staged to go with the next message.
///
/// The composer's one rule that matters most lives here, in a plain object rather than in view
/// state: **what is sent is taken out of the tray in the same synchronous step that decides to
/// send it.** The Expo app emptied its tray only after the send resolved, so a second Return that
/// landed while the first send was in flight found the same attachments still staged and sent them
/// again (HERM-126). `take()` empties the tray before anything is awaited; a second press finds
/// nothing, and a send that fails hands back exactly what it took with `restore(_:)`, ahead of
/// anything staged since and never twice.
///
/// Files are uploaded the moment they are staged, images are read and encoded; a chip that is
/// still working or has failed holds the send back (`blocked`): what the reader sees in the tray is
/// what goes. Removing a working chip cancels its upload. An uploaded file that is removed stays on
/// the gateway, as in the web client: deleting it would be a write the reader did not ask for.
@MainActor
@Observable
public final class AttachmentTray {
  /// What the tray needs from the outside.
  public struct Dependencies: Sendable {
    /// Uploads one file to the chat's workspace and answers it as an attachment. Calls `onProgress`
    /// with 0 to 1. Throws `AttachmentUploadError` or a `GatewayError`.
    public var upload: @Sendable (PickedFile, @escaping @Sendable (Double) -> Void) async throws -> OutgoingAttachment
    /// The file's bytes as plain base64.
    public var readBase64: @Sendable (URL) async throws -> String
    public var newID: @Sendable () -> String

    public init(
      upload: @escaping @Sendable (PickedFile, @escaping @Sendable (Double) -> Void) async throws -> OutgoingAttachment,
      readBase64: @escaping @Sendable (URL) async throws -> String = AttachmentStaging.readBase64,
      newID: @escaping @Sendable () -> String = { UUID().uuidString }
    ) {
      self.upload = upload
      self.readBase64 = readBase64
      self.newID = newID
    }
  }

  /// Attachments taken out of the tray for one send. Hand it back to `restore(_:)` or `release(_:)`.
  public struct Taken {
    /// What the send takes, in the order the reader staged them.
    public let attachments: [OutgoingAttachment]
    fileprivate let entries: [Entry]
  }

  /// The chips, oldest first.
  public private(set) var items: [StagedAttachment] = []

  @ObservationIgnored private let deps: Dependencies
  @ObservationIgnored private var entries: [Entry] = []

  public init(_ deps: Dependencies) {
    self.deps = deps
  }

  /// A chip and what only the tray holds: the file, the work, the attempt.
  @MainActor fileprivate final class Entry {
    var view: StagedAttachment
    let file: PickedFile
    /// The name an image is attached under (`AttachmentRules.imageName`); unused for a file.
    let imageName: String
    var input: OutgoingAttachment?
    var task: Task<Void, Never>?
    /// Bumped on every start: an answer for an earlier attempt is dropped.
    var attempt = 0

    init(view: StagedAttachment, file: PickedFile, imageName: String) {
      self.view = view
      self.file = file
      self.imageName = imageName
    }
  }

  // MARK: What the screen reads

  public var isEmpty: Bool { entries.isEmpty }

  /// A chip is still working, or failed and was neither retried nor removed. The send waits: a
  /// message that silently went without the file the reader can see in the tray would be the worse
  /// surprise.
  public var blocked: Bool { entries.contains { $0.view.status != .ready } }

  /// Something is still being read or uploaded.
  public var working: Bool { entries.contains { $0.view.status == .working } }

  // MARK: Staging

  /// Stage files, in the order given, and start each on its road. Answers how many were staged.
  @discardableResult
  public func add(_ files: [PickedFile]) -> Int {
    for file in files {
      let imageName = AttachmentRules.imageName(for: file.name, mimeType: file.mimeType)
      let entry = Entry(
        view: StagedAttachment(
          id: deps.newID(),
          kind: imageName == nil ? .file : .image,
          name: file.name.isEmpty ? (imageName ?? "attachment") : file.name,
          size: file.size,
          status: .working
        ),
        file: file,
        imageName: imageName ?? file.name
      )

      entries.append(entry)
      start(entry)
    }

    publish()
    return files.count
  }

  /// Take a chip away. A running upload is cancelled; an uploaded file stays on the gateway.
  public func remove(_ id: String) {
    guard let entry = entries.first(where: { $0.view.id == id }) else {
      return
    }

    entry.task?.cancel()
    entries.removeAll { $0 === entry }
    discardFile(of: entry)
    publish()
  }

  /// Start a failed chip again. An oversized file is not retried: it would be refused the same way.
  public func retry(_ id: String) {
    guard let entry = entries.first(where: { $0.view.id == id }), entry.view.status == .failed,
      entry.view.problem?.retryable ?? true
    else {
      return
    }

    start(entry)
    publish()
  }

  /// Leaving the chat: every upload stops and the tray is emptied.
  public func clear() {
    guard !entries.isEmpty else {
      return
    }

    for entry in entries {
      entry.task?.cancel()
      discardFile(of: entry)
    }

    entries = []
    publish()
  }

  // MARK: Sending

  /// Everything staged, out of the tray, in one synchronous step: the tray is empty before the
  /// caller awaits anything. Nil when there is nothing to take, or while the tray is `blocked`.
  public func take() -> Taken? {
    guard !entries.isEmpty, !blocked else {
      return nil
    }

    let taken = entries

    entries = []
    publish()

    return Taken(attachments: taken.compactMap(\.input), entries: taken)
  }

  /// A send that failed before it was painted: its attachments come back, in the order they were
  /// sent, ahead of anything staged meanwhile and never twice.
  public func restore(_ taken: Taken) {
    let back = Set(taken.entries.map(ObjectIdentifier.init))

    entries = taken.entries + entries.filter { !back.contains(ObjectIdentifier($0)) }
    publish()
  }

  /// A send that went (or was painted, and then failed): the taken chips are done with, and their
  /// local copies go.
  public func release(_ taken: Taken) {
    for entry in taken.entries {
      entry.input = nil
      discardFile(of: entry)
    }
  }

  // MARK: Work

  private func start(_ entry: Entry) {
    entry.attempt += 1
    entry.task?.cancel()
    entry.input = nil

    let attempt = entry.attempt
    let file = entry.file

    update(entry, status: .working, problem: nil, progress: nil, previewURL: nil)

    switch entry.view.kind {
    case .image:
      guard file.size <= AttachmentRules.maxImageBytes else {
        update(entry, status: .failed, problem: .tooLarge(limitBytes: AttachmentRules.maxImageBytes))
        return
      }

      let read = deps.readBase64

      entry.task = Task { [weak self, weak entry] in
        do {
          let base64 = try await read(file.url)

          guard !Task.isCancelled, let self, let entry, self.isCurrent(entry, attempt) else {
            return
          }

          entry.input = .image(filename: entry.imageName, base64: base64)
          self.update(
            entry, status: .ready, problem: nil, progress: nil,
            previewURL: file.size <= AttachmentRules.maxPreviewBytes ? file.url : nil)
          self.publish()
        } catch {
          guard !Task.isCancelled, !(error is CancellationError), let self, let entry, self.isCurrent(entry, attempt)
          else {
            return
          }

          self.update(
            entry, status: .failed, problem: .unreadable(message: (error as NSError).localizedDescription))
          self.publish()
        }
      }
    case .file:
      guard file.size <= AttachmentRules.maxFileBytes else {
        update(entry, status: .failed, problem: .tooLarge(limitBytes: AttachmentRules.maxFileBytes))
        return
      }

      let upload = deps.upload
      let id = entry.view.id
      let report: @Sendable (Double) -> Void = { [weak self] fraction in
        Task { @MainActor in
          self?.progressed(id, attempt: attempt, to: fraction)
        }
      }

      entry.task = Task { [weak self, weak entry] in
        do {
          let uploaded = try await upload(file, report)

          guard !Task.isCancelled, let self, let entry, self.isCurrent(entry, attempt) else {
            return
          }

          entry.input = uploaded
          self.update(entry, status: .ready, problem: nil, progress: nil)
          self.publish()
        } catch {
          guard !Task.isCancelled, !(error is CancellationError), let self, let entry, self.isCurrent(entry, attempt)
          else {
            return
          }

          self.update(entry, status: .failed, problem: AttachmentProblem.of(error), progress: nil)
          self.publish()
        }
      }
    }
  }

  private func progressed(_ id: String, attempt: Int, to fraction: Double) {
    guard let entry = entries.first(where: { $0.view.id == id }), isCurrent(entry, attempt),
      entry.view.status == .working
    else {
      return
    }

    // A percent at a time: a chip redrawn for every chunk would be a list's worth of work.
    guard (entry.view.progress ?? -1) + 0.01 <= fraction || fraction >= 1 else {
      return
    }

    entry.view.progress = fraction
    publish()
  }

  private func isCurrent(_ entry: Entry, _ attempt: Int) -> Bool {
    entry.attempt == attempt && entries.contains { $0 === entry }
  }

  private func update(
    _ entry: Entry,
    status: AttachmentStatus,
    problem: AttachmentProblem?,
    progress: Double? = nil,
    previewURL: URL? = nil
  ) {
    entry.view.status = status
    entry.view.problem = problem
    entry.view.progress = progress
    entry.view.previewURL = previewURL
  }

  private func publish() {
    items = entries.map(\.view)
  }

  private func discardFile(of entry: Entry) {
    let url = entry.file.url
    // Only what the app copied: the staging folder is the tray's own.
    guard url.path.hasPrefix(AttachmentStaging.directory.path) else {
      return
    }

    try? FileManager.default.removeItem(at: url)
  }
}

/// Where the app keeps the copies of the files a reader picked, until they are sent or removed.
public enum AttachmentStaging {
  /// The file's bytes as base64, read and encoded off the main actor.
  public static let readBase64: @Sendable (URL) async throws -> String = { url in
    try await Task.detached(priority: .userInitiated) {
      try Data(contentsOf: url, options: .mappedIfSafe).base64EncodedString()
    }.value
  }

  public static var directory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("hermie-attachments", isDirectory: true)
  }

  /// A fresh place for one file under `name`: its own folder, so two files of one name do not meet.
  public static func slot(for name: String) throws -> URL {
    let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

    return folder.appendingPathComponent(AttachmentRules.sanitisedName(name))
  }

  /// Copy a picked file in (reading it inside its security scope), and describe the copy.
  public static func stage(copying source: URL, name: String? = nil, mimeType: String? = nil) throws -> PickedFile {
    let scoped = source.startAccessingSecurityScopedResource()

    defer {
      if scoped {
        source.stopAccessingSecurityScopedResource()
      }
    }

    let display = name ?? source.lastPathComponent
    let destination = try slot(for: display)

    try FileManager.default.copyItem(at: source, to: destination)

    let size = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    return PickedFile(name: display, mimeType: mimeType, size: size, url: destination)
  }

  /// Stage bytes that have no file (a paste, a dropped image).
  public static func stage(data: Data, name: String, mimeType: String? = nil) throws -> PickedFile {
    let destination = try slot(for: name)

    try data.write(to: destination, options: .atomic)
    return PickedFile(name: name, mimeType: mimeType, size: data.count, url: destination)
  }

  /// Remove the copies left from an earlier run (a crash, a send that never came): every slot
  /// older than `age`. Never one a live composer may be holding, which is why it goes by age and
  /// does not clear the folder.
  public static func purge(in root: URL = directory, olderThan age: TimeInterval = 24 * 60 * 60, now: Date = Date()) {
    let manager = FileManager.default

    guard
      let slots = try? manager.contentsOfDirectory(
        at: root, includingPropertiesForKeys: [.contentModificationDateKey])
    else {
      return
    }

    for slot in slots {
      let modified = (try? slot.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast

      if now.timeIntervalSince(modified) > age {
        try? manager.removeItem(at: slot)
      }
    }
  }
}
