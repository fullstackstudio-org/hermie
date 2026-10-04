import Foundation
import HermieCore
import HermieTranscript
import Observation

#if os(macOS)
  import AppKit
#endif

/// Everything one open chat has for the files its bot shared: where they come from, how a sound or a video
/// plays, and what is up over the chat (a PDF, a video full screen, the share sheet).
///
/// The rows take it from `TranscriptItemActions.outbox`; the chat screen presents what it holds
/// (`outboxHost`), because the list may recycle the row that asked while a viewer is up.
@MainActor
@Observable
final class OutboxMedia {
  let files: OutboxFiles
  let playback: MediaPlaybackCenter
  /// The PDF the viewer shows, while it does.
  var pdf: OutboxFileModel?
  /// What the share sheet offers (a phone's way to Save to Files), while it is up.
  var shared: SharedFile?
  /// Why the last save did not go through, by the file's token; a line under its chip.
  private(set) var saveFailures: Set<String> = []

  /// One file to hand to the share sheet.
  struct SharedFile: Identifiable, Equatable {
    let id = UUID()
    let url: URL
  }

  init(files: OutboxFiles, isBlocked: @escaping () -> Bool = { false }) {
    self.files = files
    self.playback = MediaPlaybackCenter(files: files, arbiter: PlaybackArbiter(isBlocked: isBlocked))
  }

  /// A voice call (or anything else that needs the audio) is on: nothing may start while it is.
  func blockPlayback(while isBlocked: @escaping () -> Bool) {
    playback.arbiter.isBlocked = isBlocked
  }

  func present(pdf model: OutboxFileModel) {
    pdf = model
  }

  /// Keep a copy of a fetched file where the reader chooses: a save panel on a Mac (named as the card
  /// shows it), the share sheet on a phone, where Save to Files is one of the lines. Never opens it.
  func save(_ file: URL, token: String, name: String) {
    saveFailures.remove(token)

    #if os(macOS)
      if !OutboxSaver.save(file, named: name) { saveFailures.insert(token) }
    #else
      shared = SharedFile(url: file)
    #endif
  }

  func didFailToSave(_ token: String) -> Bool {
    saveFailures.contains(token)
  }

  /// The chat is closing: nothing plays on, nothing is on its way, nothing is up.
  func stop() {
    playback.stopAll()
    files.cancelAll()
    pdf = nil
    shared = nil
  }
}

#if os(macOS)
  /// The save panel of a shared file, as the gallery's: the name the card shows (without what a file system
  /// refuses), anywhere the reader chooses. The file is copied, never opened.
  @MainActor
  enum OutboxSaver {
    /// Whether the copy was made or the reader chose not to (a refusal to cancel is not a failure).
    @discardableResult
    static func save(_ file: URL, named name: String) -> Bool {
      let panel = NSSavePanel()
      panel.nameFieldStringValue = OutboxText.savedName(name)
      panel.allowsOtherFileTypes = true
      panel.canCreateDirectories = true
      // The whole name, extension included: `report.pdf.app` is never shown as `report.pdf`.
      panel.isExtensionHidden = false
      guard panel.runModal() == .OK, let destination = panel.url else { return true }

      do {
        try copy(file, to: destination)
        return true
      } catch {
        return false
      }
    }

    /// Copy a shared file to `destination` and mark the copy as downloaded (`com.apple.quarantine`), as a browser marks
    /// what it downloads: opening it later goes through Gatekeeper, whatever the bot put in it.
    static func copy(_ file: URL, to destination: URL) throws {
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.copyItem(at: file, to: destination)

      var values = URLResourceValues()
      values.quarantineProperties = [
        kLSQuarantineTypeKey as String: kLSQuarantineTypeWebDownload as String,
        kLSQuarantineAgentNameKey as String: Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Hermie",
      ]
      var marked = destination
      try marked.setResourceValues(values)
    }
  }
#endif
