import Foundation
import HermieTranscript
import SwiftUI
import UniformTypeIdentifiers

/// The two files a conversation can be exported as.
enum TranscriptFileFormat: Equatable, CaseIterable {
  case markdown
  case text

  var fileExtension: TranscriptFileExtension {
    switch self {
    case .markdown: .md
    case .text: .txt
    }
  }

  var contentType: UTType {
    switch self {
    case .markdown: UTType("net.daringfireball.markdown") ?? .plainText
    case .text: .plainText
    }
  }
}

/// A conversation as a file the reader can keep: a name, and the words.
///
/// What is exported is what is on screen (the chat's items at the reader's verbosity and
/// switches), all of it that is loaded, as the other clients do. The serialisation itself is
/// `exportTranscript`, shared with them; this supplies what that package cannot know: the device's
/// clock and the reader's own label.
struct TranscriptFile: Equatable {
  var name: String
  var content: String
  var format: TranscriptFileFormat

  /// - Parameters:
  ///   - items: the chat's visible items, oldest first.
  ///   - botName: the name the file is headed with and the bot's turns are labelled with.
  ///   - selfName: what the reader's own turns are labelled (`Strings.Chat.Export.self`).
  ///   - now: when the export is taken, for the header and the file name's day.
  ///   - timeZone: which day it is, and what a clock reads.
  ///   - formatTime: one timestamp as the reader should see it; the device's own style by default.
  static func make(
    items: [TranscriptItem],
    botName: String,
    selfName: String,
    format: TranscriptFileFormat,
    now: Date,
    timeZone: TimeZone = .current,
    formatTime: (@Sendable (Double) -> String)? = nil
  ) -> TranscriptFile {
    let clock: @Sendable (Double) -> String =
      formatTime ?? { seconds in
        Date(timeIntervalSince1970: seconds).formatted(
          Date.FormatStyle(date: .numeric, time: .shortened, timeZone: timeZone))
      }

    let exported = exportTranscript(
      items,
      TranscriptExportOptions(
        botName: botName,
        selfName: selfName,
        formatTime: clock,
        exportedAt: now.timeIntervalSince1970
      ))

    return TranscriptFile(
      name: transcriptFileName(botName, format.fileExtension, isoDay(now, timeZone)),
      content: format == .markdown ? exported.markdown : exported.text,
      format: format
    )
  }

  /// `2026-10-04`, the day in the reader's time zone.
  static func isoDay(_ date: Date, _ timeZone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }
}

/// The file the exporter writes: text, UTF-8.
struct TranscriptDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.plainText] }
  static var writableContentTypes: [UTType] { TranscriptFileFormat.allCases.map(\.contentType) }

  var text: String

  init(text: String = "") {
    self.text = text
  }

  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents, let text = String(data: data, encoding: .utf8) else {
      throw CocoaError(.fileReadCorruptFile)
    }

    self.text = text
  }

  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: Data(text.utf8))
  }
}
