import Foundation
import HermieTranscript

/// How the files a reply shares are laid out and what each kind of card does (`contract/outbox/` §2): the rules
/// the views read, apart from the views.
public enum OutboxPresentation {
  /// The card a file is shown as.
  public enum Card: Equatable, Sendable {
    /// An image: a thumbnail in the message's grid, opening the gallery.
    case picture
    /// A video: a poster that plays full screen.
    case video
    /// A sound: a compact row with a scrubber.
    case audio
    /// A PDF: a card that opens the app's own viewer.
    case document
    /// Anything else (HTML, SVG, scripts, archives, an image or a video over what this device takes): a chip the
    /// person saves deliberately. Never opened, never rendered with the app's credentials.
    case file
  }

  /// The card for `attachment`. A file over what this device takes for its kind is a chip that says so,
  /// whatever it claims to be.
  public static func card(for attachment: OutboxAttachment) -> Card {
    guard OutboxLimits.allows(attachment) else { return .file }

    switch attachment.kind {
    case .image: return .picture
    case .video: return .video
    case .audio: return .audio
    case .pdf: return .document
    case .file: return .file
    }
  }

  /// A reply's files in the order they are drawn: the pictures first, together, as the grid of the message;
  /// then every other card, in the order the bot shared them.
  public static func layout(_ attachments: [OutboxAttachment]) -> (pictures: [OutboxAttachment], others: [OutboxAttachment]) {
    var pictures: [OutboxAttachment] = []
    var others: [OutboxAttachment] = []

    for attachment in attachments {
      if card(for: attachment) == .picture {
        pictures.append(attachment)
      } else {
        others.append(attachment)
      }
    }

    return (pictures, others)
  }

  /// Whether the file is fetched as soon as its card appears: a picture (the thumbnail is the card), and a PDF small
  /// enough that its page count is worth knowing before it is opened. Everything else waits for the person.
  public static func fetchesOnAppear(_ attachment: OutboxAttachment) -> Bool {
    switch card(for: attachment) {
    case .picture: true
    case .document: attachment.size <= OutboxLimits.pdfPrefetchBytes
    case .video, .audio, .file: false
    }
  }

  /// The SF Symbol a file chip carries, by the extension of its name; the generic document for what it does
  /// not know. The name is only read for its extension.
  public static func symbol(forName name: String) -> String {
    guard let dot = name.lastIndex(of: "."), name.index(after: dot) < name.endIndex else { return "doc" }

    switch name[name.index(after: dot)...].lowercased() {
    case "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "jar":
      return "doc.zipper"
    case "txt", "md", "markdown", "log", "rtf", "text":
      return "doc.text"
    case "csv", "tsv", "xls", "xlsx", "numbers", "ods":
      return "tablecells"
    case "doc", "docx", "pages", "odt", "pdf":
      return "doc.richtext"
    case "ppt", "pptx", "key", "odp":
      return "play.rectangle"
    case "html", "htm", "xhtml", "xml", "svg", "json", "yaml", "yml", "toml", "js", "mjs", "ts", "tsx", "jsx", "css", "py", "rb", "sh",
      "bash", "zsh", "swift", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sql", "lua", "pl":
      return "chevron.left.forwardslash.chevron.right"
    case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff", "avif", "ico":
      return "photo"
    case "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aiff":
      return "waveform"
    case "mp4", "m4v", "mov", "webm", "mkv", "avi":
      return "film"
    case "exe", "msi", "app", "pkg", "apk", "bat", "cmd", "com", "scr":
      return "gearshape"
    default:
      return "doc"
    }
  }

  /// How big a file is, as a person reads it ("48 KB"): the system's own style, in bytes of 1000.
  public static func sizeText(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }

  /// A time as a scrubber shows it: `0:07`, `12:03`, `1:02:03`; nothing negative, nothing that is not a number.
  public static func clock(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds > 0 else { return "0:00" }
    let whole = Int(seconds.rounded(.down))
    let hours = whole / 3600
    let minutes = whole % 3600 / 60
    let rest = whole % 60
    let tail = String(format: "%02d", rest)
    return hours > 0 ? "\(hours):" + String(format: "%02d", minutes) + ":\(tail)" : "\(minutes):\(tail)"
  }
}
