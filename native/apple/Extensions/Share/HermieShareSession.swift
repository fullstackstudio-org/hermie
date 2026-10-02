import Foundation
import HermieShareKit
import HermieShared
import Observation
import UniformTypeIdentifiers

/**
 One share, from the moment the sheet opens to the moment it closes: load what was shared, ask
 which chat, write it down, try to deliver it, and say which of the two happened.

 The behaviour of the Expo build's `ShareViewController`, lifted out of the view controller so the
 iPhone and iPad controller (UIKit) and the Mac controller (AppKit) host the same sheet over the
 same steps. The controllers only present it, and supply the two things that differ per platform:
 how to open the app, and how to finish the extension request.

 ## The four seconds

 A share extension is a separate process, presented over another application, and the system is
 willing to kill it. So the order here is: start loading the attachments immediately, draw the
 sheet while they load, and refuse "Send" until they have finished. An entry written before the
 loads complete is an entry with fewer files in it than the person selected — which is the one
 failure that looks like it worked.

 ## It sends, and the order that makes that safe

 ADR-0026: after "Send" this process writes the entry and then TRIES to deliver it, over HTTP for
 the uploads and a short-lived socket for the message. The order is the whole of what makes that
 safe and it is not negotiable — the entry goes down FIRST, unconditionally, before any credential
 is read and before anything touches the network. Every way the attempt can fail therefore ends in
 the state this extension used to leave behind on purpose: an entry on disk, and an app that
 delivers it at its next launch.

 The sheet then says which of the two happened. On the queued path it says the share goes when
 Hermie next opens, and on iPhone and iPad that is all it does: an extension there has no
 supported way to open its app. On the Mac the app is asked to open (`Host.openApp`), which is.

 ## Why the files are copied twice

 `NSItemProvider` hands over a URL that is valid only inside its completion handler; it belongs to
 the system and may be reclaimed the moment the handler returns. So each attachment is copied into
 this process's own temporary directory as it arrives, and copied again into the App Group
 container if and when "Send" is tapped. The alternative — staging straight into the shared
 container and deleting on cancel — is one copy fewer and one leak more: a process that is killed
 between the two leaves bytes in a container nothing sweeps. The temporary directory is the
 system's to clean, and it cleans it.
 */
@MainActor
@Observable
final class HermieShareSession {
  /// What the platform controller does for the session.
  struct Host {
    /// Ask the system to bring the app forward with `url`, where the platform has a supported way to.
    /// Best effort; the result is not branched on.
    var openApp: (@MainActor (URL) -> Void)?
    /// The share is written (and maybe sent): close the sheet.
    var complete: @MainActor () -> Void
    /// Nothing was written: close the sheet. `code` 0 is the person cancelling, 1 a missing container.
    var cancel: @MainActor (_ code: Int) -> Void
  }

  private(set) var bots: [HermieShareBot]
  /// The gateway the roster belongs to, recorded in the entry.
  private var gatewayKey: String?
  private(set) var payloads: [ShareOutbox.Payload] = []
  /// Whether the attachments have finished loading; "Send" waits for them.
  private(set) var loading = true
  /// The one line the sheet shows once "Send" has been tapped, or nil while asking.
  private(set) var status: String?
  /// Whether `status` is an attempt in flight rather than its outcome.
  private(set) var busy = false

  /**
   The sessions and the sentences, read once.

   Read when the sheet opens rather than when "Send" is tapped, so the wording is already in hand
   when it is needed: the file is small, and a sheet that had to load it before it could say
   "Sending…" would show the empty sheet for that long.
   */
  private let targets = HermieShareTargets.load()
  private let host: Host

  init(host: Host) {
    self.host = host
    (bots, gatewayKey) = HermieShareRoster.snapshot()
  }

  /// Where attachments are staged: this process's temporary directory, which the system sweeps.
  nonisolated private static var staging: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("staged", isDirectory: true)
  }

  // MARK: - loading

  /**
   Every attachment of every input item, in the order the sharing app gave them.

   The loads all start at once and finish in whatever order their bytes arrive; the results are
   collected by position, because a share of three screenshots that arrives in a different order
   every time is a share nobody can predict.
   */
  func load(_ items: [Any]) {
    let providers = (items as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
      .prefix(ShareManifest.itemLimit)

    guard !providers.isEmpty else {
      loading = false

      return
    }

    let loads = providers.map { provider in
      Task { await Self.load(provider) }
    }

    Task {
      var loaded: [ShareOutbox.Payload] = []

      for load in loads {
        // Text too long to keep inline becomes a text file here, so a direct send uploads exactly
        // what the entry holds.
        if let payload = await load.value, let kept = ShareOutbox.normalise(payload, staging: Self.staging) {
          loaded.append(kept)
        }
      }

      payloads = loaded
      loading = false
      // The roster again: the app may have written it while the loads ran.
      (bots, gatewayKey) = HermieShareRoster.snapshot()
    }
  }

  /**
   One attachment, as whichever of the four kinds it is.

   The order of the checks is the whole of this function and it is not alphabetical. A file URL
   also conforms to `public.url`, and an image from Photos conforms to `public.data`, so asking the
   general questions first would classify almost everything as the most generic answer. Images are
   asked about first because an image is the thing this feature exists for and because it travels
   by a different road in the app — over the socket as bytes, resized — than a file does.
   */
  private static func load(_ provider: NSItemProvider) async -> ShareOutbox.Payload? {
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      return await copyFile(from: provider, type: .image, isImage: true)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
      return await copyFile(from: provider, type: .movie, isImage: false)
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      return await withCheckedContinuation { continuation in
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, _ in
          guard let url = value as? URL else {
            continuation.resume(returning: nil)

            return
          }

          continuation.resume(returning: stage(url, name: url.lastPathComponent, isImage: false))
        }
      }
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      return await withCheckedContinuation { continuation in
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
          continuation.resume(returning: (value as? URL).map { .url($0.absoluteString) })
        }
      }
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      return await withCheckedContinuation { continuation in
        provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
          guard let text = value as? String, !text.isEmpty else {
            continuation.resume(returning: nil)

            return
          }

          continuation.resume(returning: .text(text))
        }
      }
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
      return await copyFile(from: provider, type: .data, isImage: false)
    }

    return nil
  }

  /**
   `loadFileRepresentation` gives a URL that dies with the completion handler.

   So the copy happens INSIDE it, synchronously, before anything returns. This is the one rule of
   that API and getting it wrong produces a file that exists while the share sheet is open and is
   gone by the time the app looks.
   */
  private static func copyFile(
    from provider: NSItemProvider,
    type: UTType,
    isImage: Bool
  ) async -> ShareOutbox.Payload? {
    let suggested = provider.suggestedName

    return await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        guard let url else {
          continuation.resume(returning: nil)

          return
        }

        continuation.resume(returning: stage(url, name: suggested ?? url.lastPathComponent, isImage: isImage))
      }
    }
  }

  /** Copy into this process's temporary directory, which the system sweeps. Only a regular file. */
  nonisolated private static func stage(_ url: URL, name: String, isImage: Bool) -> ShareOutbox.Payload? {
    ShareOutbox.stage(url, name: name, isImage: isImage, in: staging)
  }

  // MARK: - the sheet

  /** One line for the list's header: what is about to be sent. */
  var summary: String {
    if loading {
      return String(localized: "Preparing…")
    }

    let files = payloads.filter {
      if case .file = $0 {
        return true
      }

      return false
    }.count

    if files > 0 {
      return String(localized: "\(files) files")
    }

    return payloads.isEmpty ? String(localized: "Nothing to send") : String(localized: "A link or some text")
  }

  // MARK: - finishing

  /**
   Write the entry, try to deliver it, and say which of the two happened.

   The ordering is the contract and it reads in one direction: the entry is on disk before anything
   else is attempted, so every failure below leaves the pre-ADR-0026 behaviour exactly as it was.
   Nothing here can lose a share and nothing here can send one twice — the claim inside
   `ShareDelivery` (with its lease and claim) is what holds the second half of that.
   */
  func send(to bot: HermieShareBot, note: String) {
    guard status == nil else {
      return
    }

    guard let outbox = ShareOutbox.system(),
      let identifier = outbox.write(bot: bot.name, gatewayKey: gatewayKey, note: note, payloads: payloads)
    else {
      // Nowhere to write means the App Group entitlement is missing from one of
      // the two signed binaries, and nothing this process does can fix it. The
      // share is abandoned rather than reported as sent.
      host.cancel(1)

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
    guard !payloads.contains(where: \.isImage) else {
      queue(identifier: identifier)

      return
    }

    status = targets.sending
    busy = true

    let request = ShareDelivery.Request(
      entry: identifier,
      bot: bot.name,
      gatewayKey: gatewayKey,
      text: messageText(note: note),
      attachments: deliverableAttachments()
    )
    let targetsFile = targets.file

    Task {
      let outcome = await ShareDelivery.deliver(
        request,
        credential: HermieShareKeychain.deliveryCredential(),
        targets: targetsFile,
        outbox: outbox
      )

      switch outcome {
      case .sent:
        // No `openApp`. The message is in the chat; pulling somebody out of the
        // application they were reading to show them that is the behaviour the
        // owner rejected.
        finish(line: targets.sentLine(bot: bot.displayName))

      case .queued, .takenByApp:
        queue(identifier: identifier)
      }
    }
  }

  func cancel() {
    host.cancel(0)
  }

  /**
   The queued path: say so ("will send when Hermie opens"), and on the Mac ask the system to open
   the app. The entry is on disk either way; the open only changes when it goes.
   */
  private func queue(identifier: String) {
    if let openApp = host.openApp, let url = DeepLink.share(id: identifier).url {
      openApp(url)
    }

    finish(line: targets.queued)
  }

  /**
   Draw the verdict, then complete the request.

   The pause is the point and it is short. A sheet that reported an outcome and vanished in the
   same frame reports nothing; a sheet that lingers is a share extension holding up whatever the
   person was doing. Nine hundred milliseconds is long enough to read four words and short enough
   not to be waited on.
   */
  private func finish(line: String) {
    status = line
    busy = false

    Task {
      try? await Task.sleep(for: .milliseconds(900))
      host.complete()
    }
  }

  /**
   The message's words, in the order `PendingShare.messageText` puts them for the same entry.

   The note first, because it is what the person typed, then each URL and each piece of shared
   text one paragraph apart. A URL is not wrapped in anything: the prompt is plain text, the bot
   reads it, and decorating it would be this extension inventing syntax the far side has never
   agreed to.
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

   Read from the STAGED copies rather than from the entry the outbox just wrote, because these are
   the URLs this process owns and their names are the ones the sheet counted. The entry's own
   copies may have been renamed to keep two `IMG_0001.jpg` apart, which matters to the app and not
   to an upload.
   */
  private func deliverableAttachments() -> [ShareDelivery.Attachment] {
    payloads.compactMap { payload in
      guard case let .file(url, name, isImage) = payload, !isImage else {
        return nil
      }

      return ShareDelivery.Attachment(url: url, name: name, mimeType: ShareOutbox.mimeType(for: url))
    }
  }
}
