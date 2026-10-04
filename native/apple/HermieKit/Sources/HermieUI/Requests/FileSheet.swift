import HermieCore
import HermieProtocol
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The sheet for an `input.file`: the person picks one or more files from the photo library
/// (no permission needed), the camera, the document scanner (where the device has one) or Files; the
/// request's limits are enforced as they are added, before any byte moves; the files are uploaded
/// directly into the request's directory with their SHA-256, with progress and a way to cancel; and
/// only then is the answer sent, naming files that are there.
///
/// A failed upload is said in the sheet, with Try again; Give up then tells the bot (`4041
/// upload_failed`). The staged copies are deleted when the sheet goes.
struct FileSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let params: InputFileParams

  @State private var files: InteractiveFileModel
  @State private var armed = false
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoSelection: [PhotosPickerItem] = []
  #if os(iOS)
    @State private var showCamera = false
    @State private var showScanner = false
  #endif
  @State private var sending: Task<Void, Never>?

  init(model: InteractiveModel, prompt: InteractivePrompt, params: InputFileParams) {
    self.model = model
    self.prompt = prompt
    self.params = params
    _files = State(initialValue: InteractiveFileModel(params: params))
  }

  /// Where a file can come from on this device, the one the request prefers first.
  enum Source: Hashable {
    case photos, camera, scan, files

    var icon: String {
      switch self {
      case .photos: "photo.on.rectangle"
      case .camera: "camera"
      case .scan: "doc.viewfinder"
      case .files: "folder"
      }
    }

    var title: String {
      switch self {
      case .photos: NativeStrings.Composer.Attach.photoLibrary
      case .camera: NativeStrings.Composer.Attach.camera
      case .scan: NativeStrings.Interactive.File.scan
      case .files: NativeStrings.Composer.Attach.files
      }
    }
  }

  /// The sources this request and this device offer, in the order they are shown.
  static func sources(for params: InputFileParams, camera: Bool, scanner: Bool) -> [Source] {
    let accept = params.accept
    let pictures = accept == nil || accept == .image || accept == .any
    let pages = accept == nil || accept == .document || accept == .image || accept == .any
    var sources: [Source] = []

    if pictures {
      sources.append(.photos)
    }

    if pictures, camera {
      sources.append(.camera)
    }

    if pages, scanner {
      sources.append(.scan)
    }

    sources.append(.files)

    // What the request would rather have goes first; the person may always pick another.
    let preferred: Source? =
      switch params.capture {
      case .photo?: .camera
      case .scan?: .scan
      default: accept == .document ? .scan : nil
      }

    if let preferred, let index = sources.firstIndex(of: preferred) {
      sources.move(fromOffsets: [index], toOffset: 0)
    }

    return sources
  }

  private var sources: [Source] {
    #if os(iOS)
      Self.sources(for: params, camera: CameraPicker.isAvailable, scanner: DocumentScanner.isSupported)
    #else
      Self.sources(for: params, camera: false, scanner: false)
    #endif
  }

  private var choosing: Bool {
    files.phase == .choosing || files.phase == .failed
  }

  private var busy: Bool {
    files.phase == .uploading || model.isSending
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "paperclip",
      title: NativeStrings.Interactive.titleFile(model.botName),
      busy: busy
    ) {
      VStack(alignment: .leading, spacing: 16) {
        Text(verbatim: limitsLine)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("file.limits")
        if files.stripsMetadata {
          Label(NativeStrings.Interactive.File.stripNote, systemImage: "location.slash")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        if choosing, !params.isMultiple || files.hasRoom {
          sourceButtons
        }

        chosen

        if let rejection = files.rejection {
          Label(rejectionText(rejection), systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("file.rejection")
        }

        progress
      }
      .disabled(model.isSending)
    } actions: {
      actions
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    .photosPicker(
      isPresented: $showPhotos,
      selection: $photoSelection,
      maxSelectionCount: params.isMultiple ? max(1, files.maxFiles - files.items.count) : 1,
      matching: params.accept == .image ? .images : .any(of: [.images, .videos]),
      // What the library holds: a movie is not transcoded to be picked. A photo is made ready for the
      // gateway (location removed, HEIC as JPEG) as it is staged.
      preferredItemEncoding: .current
    )
    .onChange(of: photoSelection) { _, items in
      guard !items.isEmpty else {
        return
      }

      photoSelection = []
      let files = self.files

      Task {
        await files.whilePreparing {
          for item in items {
            if let photo = try? await item.loadTransferable(type: PickedPhoto.self) {
              await files.importStaged(photo.file)
            } else {
              files.noteUnreadable(NativeStrings.Composer.Attach.photo)
            }
          }
        }
      }
    }
    .fileImporter(
      isPresented: $showFiles,
      allowedContentTypes: InteractiveFileStaging.contentTypes(for: params.accept),
      allowsMultipleSelection: params.isMultiple
    ) { result in
      if case .success(let urls) = result {
        let files = self.files
        Task { await files.importFiles(urls) }
      }
    }
    #if os(iOS)
      .sheet(isPresented: $showCamera) {
        CameraPicker { jpeg in
          let files = self.files
          Task { await files.importPhoto(jpeg) }
        }
      }
      // A sheet, never a full-screen cover: a cover fires this sheet's `onDisappear`, which would
      // throw away the files already chosen.
      .sheet(isPresented: $showScanner) {
        DocumentScanner { pages in
          let files = self.files
          Task { await files.importScan(pages: pages) }
        }
        .ignoresSafeArea()
      }
    #endif
    .onDisappear {
      sending?.cancel()
      files.discardAll()
    }
  }

  // MARK: Pieces

  /// "Up to 3 files · 10 MB per file · 25 MB in total".
  private var limitsLine: String {
    var parts = [params.isMultiple ? NativeStrings.Interactive.File.upToFiles(files.maxFiles) : NativeStrings.Interactive.File.oneFile]
    parts.append(NativeStrings.Interactive.File.perFile(AttachmentFormat.limit(files.maxBytes)))

    if params.isMultiple, files.maxTotalBytes != files.maxBytes {
      parts.append(NativeStrings.Interactive.File.inTotal(AttachmentFormat.limit(files.maxTotalBytes)))
    }

    return parts.joined(separator: " · ")
  }

  private var sourceButtons: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(sources.enumerated()), id: \.element) { index, source in
        let button = Button {
          open(source)
        } label: {
          Label(source.title, systemImage: source.icon)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .controlSize(.large)
        .disabled(!armed)
        .accessibilityIdentifier("file.source.\(source)")

        if index == 0 {
          button.buttonStyle(.borderedProminent)
        } else {
          button.buttonStyle(.bordered)
        }
      }
    }
  }

  private func open(_ source: Source) {
    switch source {
    case .photos:
      showPhotos = true
    case .files:
      showFiles = true
    case .camera:
      #if os(iOS)
        showCamera = true
      #endif
    case .scan:
      #if os(iOS)
        showScanner = true
      #endif
    }
  }

  @ViewBuilder private var chosen: some View {
    if files.items.isEmpty, files.preparing == 0 {
      Text(NativeStrings.Interactive.File.noFiles)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("file.none")
    } else {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(files.items) { item in
          HStack(spacing: 10) {
            Image(systemName: Self.icon(forFileNamed: item.file.name))
              .foregroundStyle(.secondary)
              .frame(width: 24)
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
              Text(verbatim: item.file.name)
                .lineLimit(2)
                .truncationMode(.middle)
              Text(verbatim: AttachmentFormat.size(item.file.size))
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            if choosing {
              Button {
                files.remove(item.id)
              } label: {
                Image(systemName: "xmark.circle.fill")
                  .foregroundStyle(.secondary)
                  .accessibilityLabel(NativeStrings.Composer.Attach.remove(name: item.file.name))
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier("file.remove")
            }
          }
          .padding(10)
          .background(.background.secondary, in: .rect(cornerRadius: 10))
        }

        if files.preparing > 0 {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text(NativeStrings.Composer.Attach.reading)
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("file.preparing")
        }
      }
    }
  }

  @ViewBuilder private var progress: some View {
    switch files.phase {
    case .uploading:
      VStack(alignment: .leading, spacing: 6) {
        ProgressView(value: files.progress)
        Text(NativeStrings.Composer.Attach.uploading(percent: Int((files.progress * 100).rounded())))
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("file.progress")
    case .failed:
      VStack(alignment: .leading, spacing: 6) {
        Label(NativeStrings.Interactive.File.uploadFailed, systemImage: "exclamationmark.triangle")
          .font(.callout.weight(.semibold))
          .foregroundStyle(.red)
        if let failure = files.failure {
          Text(verbatim: failure.message)
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
        Text(NativeStrings.Interactive.File.giveUpNote)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("file.failed")
    case .uploaded:
      Label(NativeStrings.Interactive.File.uploaded, systemImage: "checkmark.circle")
        .foregroundStyle(.green)
        .accessibilityIdentifier("file.uploaded")
    case .choosing:
      EmptyView()
    }
  }

  // MARK: Actions

  @ViewBuilder private var actions: some View {
    if files.phase == .uploading {
      Button {
        files.cancel()
      } label: {
        Text(NativeStrings.Interactive.File.cancelUpload)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .accessibilityIdentifier("file.cancel")
    } else {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) { buttons(mainLast: true) }
        VStack(spacing: 10) { buttons(mainLast: false) }
      }
    }
  }

  @ViewBuilder private func buttons(mainLast: Bool) -> some View {
    if !mainLast {
      mainButton
    }

    LaterButton(model: model)

    if files.phase == .failed {
      Button {
        Task {
          if await model.cannotShow(reason: CannotShowReason.uploadFailed) {
            files.discardAll()
          }
        }
      } label: {
        Text(NativeStrings.Interactive.File.giveUp)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.red)
      .controlSize(.large)
      .disabled(!armed || model.isSending)
      .accessibilityIdentifier("file.giveUp")
    }

    if files.phase == .uploaded {
      Button {
        files.reopen()
      } label: {
        Text(NativeStrings.Interactive.File.changeFiles)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .disabled(model.isSending)
      .accessibilityIdentifier("file.change")
    } else if prompt.offersSkip {
      SkipButton(model: model, armed: armed, onSkipped: { files.discardAll() })
    }

    if mainLast {
      mainButton
    }
  }

  private var mainButton: some View {
    Button {
      send()
    } label: {
      Text(mainTitle)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || model.isSending || !canSend)
    .accessibilityIdentifier("file.send")
  }

  private var mainTitle: String {
    switch files.phase {
    case .uploaded: model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.send
    case .failed: NativeStrings.Interactive.tryAgain
    default: NativeStrings.Interactive.File.uploadAndSend
    }
  }

  private var canSend: Bool {
    files.phase == .uploaded ? files.canAnswer : files.canUpload
  }

  /// Upload what was chosen, then answer with the references (or just answer again when the files
  /// are already on the gateway).
  private func send() {
    guard armed, !model.isSending, canSend else {
      return
    }

    let files = self.files
    let model = self.model

    sending = Task {
      guard let references = await files.upload(through: model.uploader) else {
        return
      }

      if await model.answer(.files(references, text: nil)) {
        files.discardAll()
      }
    }
  }

  // MARK: Words

  private func rejectionText(_ rejection: InteractiveFileModel.Rejection) -> String {
    typealias Words = NativeStrings.Interactive.File

    switch rejection {
    case .tooMany(let limit): return Words.rejectTooMany(limit)
    case .tooLarge(let name, let limit):
      return Words.rejectTooLarge(InteractivePrompt.line(name, limit: InteractivePrompt.labelLimit), AttachmentFormat.limit(limit))
    case .totalTooLarge(let limit): return Words.rejectTotal(AttachmentFormat.limit(limit))
    case .unreadable(let name): return Words.rejectUnreadable(InteractivePrompt.line(name, limit: InteractivePrompt.labelLimit))
    }
  }

  static func icon(forFileNamed name: String) -> String {
    guard let type = UTType(filenameExtension: (name as NSString).pathExtension) else {
      return "doc"
    }

    if type.conforms(to: .image) { return "photo" }
    if type.conforms(to: .pdf) { return "doc.richtext" }
    if type.conforms(to: .audio) { return "waveform" }
    if type.conforms(to: .movie) { return "film" }
    return "doc"
  }
}
