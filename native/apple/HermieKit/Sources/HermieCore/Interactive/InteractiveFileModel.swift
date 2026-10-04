import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// One local file to one absolute path on the gateway, answering the path it landed on
/// (`GatewayLink.uploadFile`). `onProgress` gets 0 to 1; cancelling the task cancels the upload.
public typealias InteractiveUploader =
  @Sendable (
    _ file: URL, _ name: String, _ mimeType: String, _ path: String, _ onProgress: (@Sendable (Double) -> Void)?
  ) async throws -> String

/// The files of one `input.file` request, from the person choosing them to the upload and the
/// references the answer carries.
///
/// The files are the person's, on this device, in the app's own staging folder until the request
/// ends (`discardAll()`); what goes out is the upload, DIRECTLY into `upload.dir` (flat, no
/// subdirectory) as `<16 lowercase hex>-<safe name>`, and then the answer's references (path, name,
/// type, bytes and SHA-256 of the bytes as uploaded). `max_files`, `max_bytes` and
/// `max_total_bytes` are enforced as files are added, before any byte moves.
@MainActor
@Observable
public final class InteractiveFileModel {
  /// A file chosen, not uploaded yet.
  public struct Item: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public var file: PickedFile

    public init(file: PickedFile) {
      self.file = file
    }
  }

  /// Why a file was not added.
  public enum Rejection: Equatable, Sendable {
    /// More files than `max_files` (or than one, without `multiple`).
    case tooMany(limit: Int)
    /// A file over `max_bytes`.
    case tooLarge(name: String, limit: Int)
    /// The files together over `max_total_bytes`.
    case totalTooLarge(limit: Int)
    /// The file could not be read from this device.
    case unreadable(name: String)
  }

  public enum Phase: Equatable, Sendable {
    /// Files are being chosen.
    case choosing
    /// The files are on their way.
    case uploading
    /// Every file is on the gateway; what is left is the answer.
    case uploaded
    /// An upload failed: `failure` says how.
    case failed
  }

  public let params: InputFileParams
  public private(set) var items: [Item] = []
  public private(set) var phase = Phase.choosing
  /// 0 to 1 over all the files, by bytes.
  public private(set) var progress = 0.0
  /// Why the last file was not added; nil once something is added or removed.
  public private(set) var rejection: Rejection?
  /// How the upload failed, in the composer's words (`AttachmentProblem`).
  public private(set) var failure: AttachmentProblem?
  /// Files are being read (copied, stripped, assembled) before they are listed.
  public private(set) var preparing = 0
  /// The references of the files that are on the gateway, once `phase` is `uploaded`.
  public private(set) var uploaded: [UploadedFile] = []

  @ObservationIgnored private var task: Task<[UploadedFile], any Error>?
  @ObservationIgnored private let token: @Sendable () -> String

  public init(params: InputFileParams, token: @escaping @Sendable () -> String = InteractiveFileModel.randomToken) {
    self.params = params
    self.token = token
  }

  // MARK: - The request's bounds

  /// The most files the answer may hold.
  public var maxFiles: Int {
    let asked = max(1, params.upload?.maxFiles ?? 10)
    return params.isMultiple ? asked : 1
  }

  /// The most one file may hold, in bytes.
  public var maxBytes: Int {
    params.upload?.maxBytes ?? 104_857_600
  }

  /// The most all the files may hold together.
  public var maxTotalBytes: Int {
    params.upload?.maxTotalBytes ?? 104_857_600
  }

  /// Whether the files are metadata-stripped before they go out.
  public var stripsMetadata: Bool {
    params.upload?.stripMetadata ?? false
  }

  public var totalBytes: Int {
    items.reduce(0) { $0 + $1.file.size }
  }

  /// Another file can be added.
  public var hasRoom: Bool {
    params.isMultiple ? items.count < maxFiles : true
  }

  /// There is something to upload, and nothing is being read or sent.
  public var canUpload: Bool {
    !items.isEmpty && preparing == 0 && (phase == .choosing || phase == .failed)
  }

  /// The files are chosen and uploaded: the answer can go out.
  public var canAnswer: Bool {
    phase == .uploaded && !uploaded.isEmpty
  }

  // MARK: - Choosing

  /// Add a file the person chose. One request that allows a single file takes the newest in place
  /// of the one before. A file that does not fit is left out (and its copy deleted), with the
  /// reason in `rejection`.
  @discardableResult
  public func add(_ file: PickedFile) -> Bool {
    guard phase == .choosing || phase == .failed else {
      AttachmentStaging.discard(file.url)
      return false
    }

    if !params.isMultiple {
      removeAll()
    }

    if items.count >= maxFiles {
      AttachmentStaging.discard(file.url)
      rejection = .tooMany(limit: maxFiles)
      return false
    }

    if file.size > maxBytes {
      AttachmentStaging.discard(file.url)
      rejection = .tooLarge(name: file.name, limit: maxBytes)
      return false
    }

    if totalBytes + file.size > maxTotalBytes {
      AttachmentStaging.discard(file.url)
      rejection = .totalTooLarge(limit: maxTotalBytes)
      return false
    }

    items.append(Item(file: file))
    resetUpload()
    rejection = nil
    return true
  }

  public func remove(_ id: Item.ID) {
    guard phase == .choosing || phase == .failed, let index = items.firstIndex(where: { $0.id == id }) else {
      return
    }

    AttachmentStaging.discard(items[index].file.url)
    items.remove(at: index)
    resetUpload()
    rejection = nil
  }

  private func removeAll() {
    for item in items {
      AttachmentStaging.discard(item.file.url)
    }

    items = []
    resetUpload()
  }

  /// Go back to choosing from an upload that is done or failed: the files stay listed, and the
  /// next upload sends them again (to new names).
  public func reopen() {
    guard phase == .uploaded || phase == .failed else {
      return
    }

    resetUpload()
  }

  /// Something changed that the files on the gateway no longer match.
  private func resetUpload() {
    uploaded = []
    failure = nil
    progress = 0

    if phase != .uploading {
      phase = .choosing
    }
  }

  /// Files picked in Files, or dragged in: copied in, stripped when asked, then added. Each one
  /// that cannot be is reported in `rejection`.
  public func importFiles(_ urls: [URL]) async {
    for url in urls {
      let limit = maxBytes
      let strips = stripsMetadata
      preparing += 1
      let staged = await Task.detached(priority: .userInitiated) {
        Self.staged { () throws(StagingFailure) in
          let copy = try InteractiveFileStaging.copy(url, limit: limit)
          return strips ? try InteractiveFileStaging.strippingMetadata(copy) : copy
        }
      }.value
      preparing -= 1
      take(staged, named: url.lastPathComponent)
    }
  }

  /// A file already staged by a picker of the app's own (a library photo): stripped when asked,
  /// then added.
  public func importStaged(_ file: PickedFile) async {
    guard stripsMetadata else {
      add(file)
      return
    }

    preparing += 1
    let staged = await Task.detached(priority: .userInitiated) {
      Self.staged { () throws(StagingFailure) in try InteractiveFileStaging.strippingMetadata(file) }
    }.value
    preparing -= 1
    take(staged, named: file.name)
  }

  /// One photograph from the camera (a JPEG from its pixels: no metadata of the camera's).
  public func importPhoto(_ jpeg: Data, now: Date = Date()) async {
    let name = InteractiveFileStaging.dated("Photo", ext: "jpg", now: now)
    preparing += 1
    let staged = await Task.detached(priority: .userInitiated) {
      Self.staged { () throws(StagingFailure) in
        try AttachmentStaging.stage(data: jpeg, name: name, mimeType: "image/jpeg")
      }
    }.value
    preparing -= 1
    take(staged, named: name)
  }

  /// A scan: the pages (JPEG each) as one PDF for a request that accepts a document, as one image
  /// per page otherwise (up to what the request allows).
  public func importScan(pages: [Data], now: Date = Date()) async {
    let asPDF = params.accept == .document
    preparing += 1
    let staged = await Task.detached(priority: .userInitiated) {
      Self.staged { () throws(StagingFailure) -> [PickedFile] in
        if asPDF {
          return [try InteractiveFileStaging.pdf(fromPages: pages, named: InteractiveFileStaging.dated("Scan", ext: "pdf", now: now))]
        }

        let base = (InteractiveFileStaging.dated("Scan", ext: "jpg", now: now) as NSString).deletingPathExtension
        return try InteractiveFileStaging.jpegs(fromPages: pages, baseName: base)
      }
    }.value
    preparing -= 1

    switch staged {
    case .success(let files):
      for file in files {
        add(file)
      }
    case .failure:
      rejection = .unreadable(name: "Scan")
    }
  }

  private nonisolated static func staged<T: Sendable>(_ work: () throws(StagingFailure) -> T) -> Result<T, StagingFailure> {
    do {
      return .success(try work())
    } catch {
      return .failure(error)
    }
  }

  /// Run `work` (reading a file from the photo library, say) with the sheet saying files are being
  /// prepared.
  public func whilePreparing(_ work: () async -> Void) async {
    preparing += 1
    await work()
    preparing -= 1
  }

  /// A file could not be read from this device.
  public func noteUnreadable(_ name: String) {
    rejection = .unreadable(name: name)
  }

  private func take(_ staged: Result<PickedFile, StagingFailure>, named name: String) {
    switch staged {
    case .success(let file):
      add(file)
    case .failure(.tooLarge):
      rejection = .tooLarge(name: name, limit: maxBytes)
    case .failure(.unreadable), .failure(.unsupported):
      // A folder is not one file to hand over: it cannot be read as one.
      rejection = .unreadable(name: name)
    }
  }

  // MARK: - Uploading

  /// `<dir>/<16 lowercase hex>-<safe name>`: directly in the request's directory.
  func path(for file: PickedFile, in dir: String) -> String {
    var root = dir

    while root.count > 1, root.hasSuffix("/") {
      root.removeLast()
    }

    return "\(root == "/" ? "" : root)/\(token())-\(AttachmentRules.sanitisedName(file.name))"
  }

  /// The longest `name` of an uploaded file, in code points (`UploadedFile`'s `maxLength`).
  public nonisolated static let nameLimit = 120
  /// The longest `mime` of an uploaded file.
  public nonisolated static let mimeLimit = 80

  /// The name an answer carries: the file's own, cut to `nameLimit` code points with its extension
  /// kept (`a-very-long-name….pdf`), and never empty.
  public nonisolated static func answerName(_ name: String) -> String {
    let scalars = Array(name.unicodeScalars)

    if scalars.isEmpty {
      return "file"
    }

    guard scalars.count > nameLimit else {
      return name
    }

    // A short extension survives the cut; a "extension" that is most of the name does not.
    let ext = (name as NSString).pathExtension
    let keep = ext.isEmpty || ext.unicodeScalars.count > 16 ? "" : ".\(ext)"
    let room = nameLimit - keep.unicodeScalars.count
    var cut = String.UnicodeScalarView()
    cut.append(contentsOf: scalars.prefix(room))
    return String(cut) + keep
  }

  /// The type an answer carries: the file's own when it fits the contract, else the generic one.
  public nonisolated static func answerMime(_ mime: String?) -> String {
    guard let mime, !mime.isEmpty, mime.unicodeScalars.count <= mimeLimit else {
      return AttachmentRules.fallbackType
    }

    return mime
  }

  /// Sixteen lowercase hex characters.
  public nonisolated static func randomToken() -> String {
    (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  }

  /// Upload every file and answer the references, or `nil` when it did not come to that: the person
  /// cancelled (`phase` is `choosing` again, nothing is answered) or an upload failed (`phase` is
  /// `failed`, `failure` says how, and nothing is answered). Files already on the gateway from an
  /// earlier try are not sent twice.
  public func upload(through uploader: @escaping InteractiveUploader) async -> [UploadedFile]? {
    if phase == .uploaded, !uploaded.isEmpty {
      return uploaded
    }

    guard canUpload, let dir = params.upload?.dir else {
      return nil
    }

    let files = items.map(\.file)
    let total = max(1, files.reduce(0) { $0 + $1.size })
    let target = params.upload
    let tokens = files.map { path(for: $0, in: dir) }

    phase = .uploading
    progress = 0
    failure = nil

    let report: @Sendable (Double) -> Void = { [weak self] overall in
      Task { @MainActor in self?.advance(to: overall) }
    }
    let running = Task { () -> [UploadedFile] in
      var done: [UploadedFile] = []
      var sent = 0

      for (file, path) in zip(files, tokens) {
        try Task.checkCancellation()

        let digest = try await InteractiveFileStaging.sha256(of: file.url)
        let size = AttachmentStaging.size(of: file.url) ?? file.size
        let before = sent
        let safe = AttachmentRules.sanitisedName(file.name)
        let stored = try await uploader(file.url, safe, file.mimeType ?? AttachmentRules.fallbackType, path) { fraction in
          report((Double(before) + fraction * Double(size)) / Double(total))
        }

        sent += size
        // The gateway's own word for where it landed (a symlinked home is the ordinary case), as
        // long as that is still directly in the directory.
        let landed = target?.contains(path: stored) == true ? stored : path
        done.append(
          UploadedFile(
            path: landed,
            name: Self.answerName(file.name),
            mime: Self.answerMime(file.mimeType),
            bytes: size,
            sha256: digest))
      }

      return done
    }

    self.task = running

    do {
      let done = try await running.value
      self.task = nil
      uploaded = done
      progress = 1
      phase = .uploaded
      return done
    } catch is CancellationError {
      self.task = nil
      phase = .choosing
      progress = 0
      return nil
    } catch {
      self.task = nil

      if Task.isCancelled || (error as? URLError)?.code == .cancelled {
        phase = .choosing
        progress = 0
        return nil
      }

      failure = AttachmentProblem.of(error)
      phase = .failed
      return nil
    }
  }

  private func advance(to value: Double) {
    if phase == .uploading {
      progress = max(progress, min(1, value))
    }
  }

  /// Stop an upload on its way. Files that already reached the gateway stay there; nothing is
  /// answered.
  public func cancel() {
    task?.cancel()
  }

  /// The files go: their copies are deleted and the model is empty again.
  public func discardAll() {
    task?.cancel()
    removeAll()
    rejection = nil
    phase = .choosing
  }
}
