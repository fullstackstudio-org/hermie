import SwiftUI
import UIKit
import UniformTypeIdentifiers

/**
 The share extension's entry point: load what was shared, ask which chat, write
 it down, hand over to the app.

 `@objc(ShareViewController)` is load-bearing. `Info.plist` names the principal
 class as a plain string and the loader looks it up in the Objective-C runtime;
 without the attribute a Swift class is registered as
 `HermieShareExtension.ShareViewController`, the lookup finds nothing, and the
 share sheet presents an empty panel with no error in any log.

 ## The four seconds

 A share extension is a separate process, presented over another application,
 and the system is willing to kill it. So the order here is: start loading the
 attachments immediately, draw the sheet while they load, and refuse "Send"
 until they have finished. An entry written before the loads complete is an
 entry with fewer files in it than the person selected — which is the one
 failure that looks like it worked.

 ## It now sends, and the order that makes that safe

 ADR-0026: after "Send" this process writes the entry and then TRIES to deliver
 it, over HTTP for the uploads and a short-lived socket for the message. The
 order is the whole of what makes that safe and it is not negotiable — the entry
 goes down FIRST, unconditionally, before any credential is read and before
 anything touches the network. Every way the attempt can fail therefore ends in
 the state this extension used to leave behind on purpose: an entry on disk, and
 an app that delivers it at its next launch.

 The sheet then says which of the two happened, and the app is only asked to open
 on the queued path. A share that has already arrived has no reason to pull
 somebody out of the application they were reading.

 ## Why the files are copied twice

 `NSItemProvider` hands over a URL that is valid only inside its completion
 handler; it belongs to the system and may be reclaimed the moment the handler
 returns. So each attachment is copied into this process's own temporary
 directory as it arrives, and copied again into the App Group container if and
 when "Send" is tapped. The alternative — staging straight into the shared
 container and deleting on cancel — is one copy fewer and one leak more: a
 process that is killed between the two leaves bytes in a container nothing
 sweeps. The temporary directory is the system's to clean, and it cleans it.
 */
@objc(ShareViewController)
class ShareViewController: UIViewController {
  private var payloads: [HermieShareOutbox.Payload] = []
  private var loading = true
  private var hosting: UIHostingController<HermieShareSheet>?

  /** The one line the sheet shows once "Send" has been tapped. See the sheet. */
  private var status: String?
  private var busy = false

  /**
   The sessions and the two sentences, read once.

   Read here rather than at the moment "Send" is tapped so that the wording is
   already in hand when it is needed: the file is small, the read is a few
   hundred microseconds, and a `Task` that had to load it before it could say
   "Sending…" would show the empty sheet for that long.
   */
  private let targets = HermieShareTargets.load()

  override func viewDidLoad() {
    super.viewDidLoad()

    // Before the sheet, so the loads and the roster read overlap rather than
    // queue: the roster is one small file and comes back immediately, and the
    // attachments are what anyone waits for.
    loadAttachments()
    present(bots: HermieShareRoster.load())
  }

  // MARK: - the sheet

  private func present(bots: [HermieShareBot]) {
    let sheet = HermieShareSheet(
      bots: bots,
      summary: summaryText,
      loading: loading,
      status: status,
      busy: busy,
      onSend: { [weak self] bot, note in self?.send(to: bot, note: note) },
      onCancel: { [weak self] in self?.cancel() }
    )

    if let hosting {
      // Re-rendered rather than re-presented: this is called again when the
      // loads finish, and swapping the whole controller would throw away
      // whatever the person had already typed or picked.
      hosting.rootView = sheet

      return
    }

    let controller = UIHostingController(rootView: sheet)

    addChild(controller)
    controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(controller.view)
    controller.didMove(toParent: self)
    hosting = controller
  }

  /** One line for the list's header: what is about to be sent. */
  private var summaryText: String {
    if loading {
      return "Preparing…"
    }

    let files = payloads.filter { if case .file = $0 { return true } else { return false } }.count

    if files == 1 {
      return "1 file"
    }

    if files > 1 {
      return "\(files) files"
    }

    return payloads.isEmpty ? "Nothing to send" : "A link or some text"
  }

  // MARK: - loading

  /**
   Every attachment of every input item, in the order the sharing app gave them.

   A `DispatchGroup` rather than a counter, and the results are collected into a
   dictionary keyed by position rather than appended: the providers finish in
   whatever order their bytes arrive, and a share of three screenshots that
   arrives in a different order every time is a share nobody can predict.
   */
  private func loadAttachments() {
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
      .prefix(HermieShareOutbox.itemLimit)

    guard !providers.isEmpty else {
      loading = false

      return
    }

    let group = DispatchGroup()
    let lock = NSLock()
    var loaded: [Int: HermieShareOutbox.Payload] = [:]

    for (index, provider) in providers.enumerated() {
      group.enter()

      load(provider) { payload in
        if let payload {
          lock.lock()
          loaded[index] = payload
          lock.unlock()
        }

        group.leave()
      }
    }

    group.notify(queue: .main) { [weak self] in
      guard let self else {
        return
      }

      self.payloads = loaded.keys.sorted().compactMap { loaded[$0] }
      self.loading = false
      self.present(bots: HermieShareRoster.load())
    }
  }

  /**
   One attachment, as whichever of the four kinds it is.

   The order of the checks is the whole of this function and it is not
   alphabetical. A file URL also conforms to `public.url`, and an image from
   Photos conforms to `public.data`, so asking the general questions first would
   classify almost everything as the most generic answer. Images are asked about
   first because an image is the thing this feature exists for and because it
   travels by a different road in the app — over the socket as bytes, resized —
   than a file does.
   */
  private func load(_ provider: NSItemProvider, completion: @escaping (HermieShareOutbox.Payload?) -> Void) {
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      copyFile(from: provider, typeIdentifier: UTType.image.identifier, isImage: true, completion: completion)

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
      copyFile(from: provider, typeIdentifier: UTType.movie.identifier, isImage: false, completion: completion)

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] value, _ in
        guard let self, let url = value as? URL else {
          completion(nil)

          return
        }

        completion(self.stage(url, name: url.lastPathComponent, isImage: false))
      }

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
        guard let url = value as? URL else {
          completion(nil)

          return
        }

        completion(.url(url.absoluteString))
      }

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
        guard let text = value as? String, !text.isEmpty else {
          completion(nil)

          return
        }

        completion(.text(text))
      }

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
      copyFile(from: provider, typeIdentifier: UTType.data.identifier, isImage: false, completion: completion)

      return
    }

    completion(nil)
  }

  /**
   `loadFileRepresentation` gives a URL that dies with the completion handler.

   So the copy happens INSIDE it, synchronously, before anything returns. This
   is the one rule of that API and getting it wrong produces a file that exists
   while the share sheet is open and is gone by the time the app looks.
   */
  private func copyFile(
    from provider: NSItemProvider,
    typeIdentifier: String,
    isImage: Bool,
    completion: @escaping (HermieShareOutbox.Payload?) -> Void
  ) {
    provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, _ in
      guard let self, let url else {
        completion(nil)

        return
      }

      completion(self.stage(url, name: provider.suggestedName ?? url.lastPathComponent, isImage: isImage))
    }
  }

  /** Copy into this process's temporary directory, which the system sweeps. */
  private func stage(_ url: URL, name: String, isImage: Bool) -> HermieShareOutbox.Payload? {
    let safe = HermieShareOutbox.safeFileName(name)
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
      .appendingPathComponent(safe)

    do {
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try FileManager.default.copyItem(at: url, to: destination)
    } catch {
      return nil
    }

    return .file(url: destination, name: safe, isImage: isImage)
  }

  // MARK: - finishing

  /**
   Write the entry, try to deliver it, and say which of the two happened.

   The ordering is the contract and it reads in one direction: the entry is on
   disk before anything else is attempted, so every failure below leaves the
   pre-ADR-0026 behaviour exactly as it was. Nothing here can lose a share and
   nothing here can send one twice — the claim inside `HermieShareSender` is what
   holds the second half of that.
   */
  private func send(to bot: HermieShareBot, note: String) {
    guard let identifier = HermieShareOutbox.write(bot: bot.name, note: note, payloads: payloads) else {
      // Nowhere to write means the App Group entitlement is missing from one of
      // the two signed binaries, and nothing this process does can fix it. The
      // share is abandoned rather than reported as sent.
      extensionContext?.cancelRequest(withError: NSError(domain: "dev.hermie.app.share", code: 1))

      return
    }

    /*
      A share carrying an image is the app's to deliver, and that is a decision
      about roads rather than about capability.

      The app resizes an image and attaches its BYTES over the socket, which is
      what puts it in the transcript. Resizing a photograph is the work a share
      extension is killed for, and the HTTP road this process has — upload, then
      reference with `@file:` — hands the agent a binary it cannot read. So an
      image queues, and the sheet says so in the same words as every other queue.
    */
    let hasImage = payloads.contains { payload in
      if case .file(_, _, true) = payload {
        return true
      }

      return false
    }

    guard !hasImage else {
      queue(identifier: identifier)

      return
    }

    status = targets.sending
    busy = true
    present(bots: HermieShareRoster.load())

    let text = messageText(note: note)
    let attachments = deliverableAttachments()

    Task { @MainActor [weak self] in
      let outcome = await HermieShareSender.deliver(
        entry: identifier,
        bot: bot.name,
        text: text,
        attachments: attachments
      )

      guard let self else {
        return
      }

      switch outcome {
      case .sent:
        // No `openApp`. The message is in the chat; pulling somebody out of the
        // application they were reading to show them that is the behaviour the
        // owner rejected.
        self.finish(line: self.targets.sentLine(bot: bot.displayName))

      case .queued:
        self.queue(identifier: identifier)
      }
    }
  }

  /**
   The queued path: say so, and ask the system to open the app.

   The `openURL` is what makes "will send when Hermie opens" happen now rather
   than at some later launch, and it is the same best-effort call this extension
   has always made — see `openApp`. Its result is deliberately not branched on:
   the entry is on disk either way, and reporting a failed `openURL` as a failed
   share would be reporting a latency problem as data loss.
   */
  private func queue(identifier: String) {
    if let url = URL(string: "hermie://share/\(identifier)") {
      openApp(url)
    }

    finish(line: targets.queued)
  }

  /**
   Draw the verdict, then complete the request.

   The pause is the point and it is short. A sheet that reported an outcome and
   vanished in the same frame reports nothing; a sheet that lingers is a share
   extension holding up whatever the person was doing. Nine hundred milliseconds
   is long enough to read four words and short enough not to be waited on.
   */
  private func finish(line: String) {
    status = line
    busy = false
    present(bots: HermieShareRoster.load())

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
      self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
  }

  /**
   The message's words, in the order `shareMessageText` puts them.

   The note first, because it is what the person typed, then each URL and each
   piece of shared text one paragraph apart. A URL is not wrapped in anything: the
   prompt is plain text, the bot reads it, and decorating it would be this
   extension inventing syntax the far side has never agreed to.

   Spelled here as well as in TypeScript for the reason every rule in this module
   is spelled twice — the two targets share no sources. What they share is the
   shape of the message, and a test on the app side is what pins it.
   */
  private func messageText(note: String) -> String {
    var lines: [String] = []
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)

    if !trimmedNote.isEmpty {
      lines.append(trimmedNote)
    }

    for payload in payloads {
      switch payload {
      case let .url(value), let .text(value):
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)

        if !trimmed.isEmpty {
          lines.append(trimmed)
        }

      case .file:
        continue
      }
    }

    return lines.joined(separator: "\n\n")
  }

  /**
   The files this process will upload: everything that is not an image.

   Read from the STAGED copies rather than from the entry the outbox just wrote,
   because these are the URLs this process owns and their names are the ones the
   sheet counted. The entry's own copies may have been renamed to keep two
   `IMG_0001.jpg` apart, which matters to the app and not to an upload.
   */
  private func deliverableAttachments() -> [HermieShareSender.Attachment] {
    payloads.compactMap { payload in
      guard case let .file(url, name, isImage) = payload, !isImage else {
        return nil
      }

      return HermieShareSender.Attachment(url: url, name: name, mimeType: Self.mimeType(for: url))
    }
  }

  /**
   A hint for the multipart part's `Content-Type`, and never more than that.

   The gateway sniffs the bytes it is given, so a wrong answer costs nothing. It is
   sent because a multipart part with no type at all is a part some proxies rewrite.
   The same table `HermieShareOutbox` keeps for the manifest, which is private to
   that file — one more duplication in a module whose two halves share no sources.
   */
  private static func mimeType(for url: URL) -> String {
    let byExtension: [String: String] = [
      "pdf": "application/pdf",
      "txt": "text/plain",
      "md": "text/markdown",
      "json": "application/json",
      "csv": "text/csv",
      "zip": "application/zip",
      "mp4": "video/mp4",
      "mov": "video/quicktime"
    ]

    return byExtension[url.pathExtension.lowercased()] ?? "application/octet-stream"
  }

  private func cancel() {
    extensionContext?.cancelRequest(withError: NSError(domain: "dev.hermie.app.share", code: 0))
  }

  /**
   Open the app from inside an extension.

   `UIApplication.shared` is unavailable to an extension, so the application
   object is reached by walking the responder chain and asked through a selector.
   This is the long-standing idiom rather than a supported API, and the honest
   position is written here rather than assumed: if it stops working, the entry
   is STILL in the outbox and the app still delivers it at its next launch. The
   only thing lost is the immediacy, which is why nothing above branches on the
   result.

   `@discardableResult` for that reason, and the selector is built by name
   because the method it names is not one this target can reference.
   */
  @discardableResult
  private func openApp(_ url: URL) -> Bool {
    // `NSSelectorFromString` rather than `#selector`, because `#selector`
    // requires a method this target can name and the whole point is that it
    // cannot: `UIApplication.open(_:options:completionHandler:)` is marked
    // unavailable in an extension.
    let selector = NSSelectorFromString("openURL:")
    var responder: UIResponder? = self

    while let current = responder {
      if current.responds(to: selector) {
        current.perform(selector, with: url)

        return true
      }

      responder = current.next
    }

    return false
  }
}
