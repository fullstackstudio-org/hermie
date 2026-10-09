import HermieTranscript
import SwiftUI

#if os(iOS)
  import SafariServices
#endif

/// The pages a reply used: the ones the assistant read, then the ones it only found. Each row is the
/// monogram, the title (the domain when the page has none) and the domain under it, always: a title is
/// whatever the page called itself, and the domain is where the link goes.
///
/// A tap does not open anything yet. It asks first, with the full domain as the question, and only the answer
/// opens the page: in a browser view inside the app on the phone, in the Mac's browser on the Mac. No row loads
/// anything, and nothing here is a link: a source is opened only by the person's own tap, through this
/// question.
struct SourcesSheet: View {
  let sources: [ReplySource]

  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @Environment(\.transcriptItemActions) private var actions
  @State private var pending: ReplySource?
  #if os(iOS)
    @State private var browsing: BrowsedPage?
  #endif

  var body: some View {
    NavigationStack {
      List {
        section(NativeStrings.Sources.read, sources.filter { $0.via == .read })
        section(NativeStrings.Sources.found, sources.filter { $0.via == .found })
      }
      #if os(iOS)
        .listStyle(.insetGrouped)
      #endif
      .navigationTitle(NativeStrings.Sources.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.App.Common.done) { dismiss() }
        }
      }
      .confirmationDialog(
        pending.map { NativeStrings.Sources.openTitle($0.domain) } ?? "",
        isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
        titleVisibility: .visible,
        presenting: pending
      ) { source in
        Button(NativeStrings.Sources.open) { open(source) }
        Button(NativeStrings.Sources.copyLink) { actions.copy(source.url) }
      } message: { source in
        Text(verbatim: SourcesSheet.shortened(source.url) + "\n" + NativeStrings.Sources.openMessage)
      }
      #if os(iOS)
        .fullScreenCover(item: $browsing) { page in
          SafariView(url: page.url).ignoresSafeArea()
        }
      #endif
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .accessibilityIdentifier("hermie.chat.sources")
  }

  @ViewBuilder
  private func section(_ title: String, _ rows: [ReplySource]) -> some View {
    if !rows.isEmpty {
      Section(title) {
        ForEach(rows) { source in
          Button {
            pending = source
          } label: {
            SourceRow(source: source)
          }
          .buttonStyle(.plain)
          .contextMenu {
            Button(NativeStrings.Sources.copyLink) { actions.copy(source.url) }
          }
        }
      }
    }
  }

  private func open(_ source: ReplySource) {
    // A source's address was checked when it was read (`http` or `https`, a host, no user info); checked
    // again here because a browser view must never be handed anything else.
    guard let url = URL(string: source.url), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"
    else { return }

    #if os(iOS)
      browsing = BrowsedPage(url: url)
    #else
      openURL(url)
    #endif
  }

  /// An address cut to a length a dialog can show: the beginning (scheme and domain stay whole) and the end.
  static func shortened(_ url: String, limit: Int = 160) -> String {
    guard url.count > limit else { return url }
    let head = url.prefix(limit * 2 / 3)
    let tail = url.suffix(limit / 3 - 1)
    return "\(head)…\(tail)"
  }
}

#if os(iOS)
  struct BrowsedPage: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
  }

  /// The in-app browser view. Only ever given an `http` or `https` address (`SFSafariViewController` refuses
  /// to be made with anything else).
  struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
      let configuration = SFSafariViewController.Configuration()
      configuration.entersReaderIfAvailable = false
      return SFSafariViewController(url: url, configuration: configuration)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
  }
#endif

/// What a row of the list says, apart from how it is drawn: the title (the domain when the page has none), the
/// domain under it whenever there is a title, and the sentence a screen reader gets. The domain is in every
/// one of them: a title is whatever the page called itself, and the domain is where the link goes.
struct SourceRowText: Equatable {
  let primary: String
  /// Under the title; `nil` when the title already is the domain.
  let secondary: String?
  let spoken: String

  init(_ source: ReplySource) {
    let domain = source.domain

    if source.title.isEmpty {
      primary = domain
      secondary = nil
      spoken = domain
    } else {
      primary = source.title
      secondary = domain
      spoken = NativeStrings.Sources.row(source.title, domain)
    }
  }
}

/// One source: the monogram, the title and the domain.
struct SourceRow: View {
  let source: ReplySource

  @ScaledMetric(relativeTo: .body) private var size: CGFloat = 32

  var body: some View {
    let text = SourceRowText(source)

    HStack(spacing: 12) {
      SourceMonogram(source: source, size: size)

      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: text.primary)
          .font(.body)
          .lineLimit(2)
          .multilineTextAlignment(.leading)

        if let secondary = text.secondary {
          Text(verbatim: secondary)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }

      Spacer(minLength: 0)
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(text.spoken)
    .accessibilityAddTraits(.isButton)
  }
}

extension NativeStrings {
  enum Sources {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Sources (the pill under a reply)
    static var pill: String { string("native.sources.pill") }
    /// Sources (the sheet's title)
    static var title: String { string("native.sources.title") }
    /// Read (the heading over the pages the assistant read)
    static var read: String { string("native.sources.read") }
    /// Found (the heading over the results it only found)
    static var found: String { string("native.sources.found") }
    /// Copy link
    static var copyLink: String { string("native.sources.copyLink") }
    /// The page opens in a browser view inside Hermie.
    static var openMessage: String { string("native.sources.openMessage") }
    /// Open
    static var open: String { string("native.sources.open") }

    /// Sources, {count}
    static func pillAccessibility(_ count: Int) -> String {
      String(
        localized: "native.sources.pillAccessibility", defaultValue: "Sources, \(count)", table: "Native",
        bundle: .module)
    }
    /// {title}, {domain}
    static func row(_ title: String, _ domain: String) -> String {
      String(
        localized: "native.sources.row", defaultValue: "\(title), \(domain)", table: "Native", bundle: .module)
    }
    /// Open {domain}?
    static func openTitle(_ domain: String) -> String {
      String(
        localized: "native.sources.openTitle", defaultValue: "Open \(domain)?", table: "Native", bundle: .module)
    }
  }
}
