#if DEBUG
  import HermieProtocol
  import HermieTranscript
  import SwiftUI

  /// Every transcript item kind in every presentation, with switches for the
  /// colour scheme, the text size (default or AX5) and the width of an iPhone,
  /// an iPad or a Mac window. A debug screen; the UI test runs the system
  /// accessibility audit on it.
  public struct TranscriptItemGallery: View {
    @State private var scheme: ColorScheme?
    @State private var largeText = false
    @State private var width: GalleryWidth = .natural
    @State private var expansion = TranscriptExpansion()
    @State private var log = "Tap a button on a card."

    public init() {}

    enum GalleryWidth: String, CaseIterable, Identifiable {
      case natural = "Fit"
      case phone = "iPhone"
      case pad = "iPad"
      case mac = "Mac"

      var id: Self { self }

      var points: CGFloat? {
        switch self {
        case .natural: nil
        case .phone: 393
        case .pad: 820
        case .mac: 1000
        }
      }
    }

    // The controls sit above the scroll view, not over it, and the headers are
    // not pinned: anything drawn over the samples makes the accessibility audit
    // measure their contrast against whatever covers them.
    public var body: some View {
      VStack(spacing: 0) {
        controls
        Divider()
        samples
      }
      .preferredColorScheme(scheme)
      .navigationTitle("Item gallery")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
    }

    private var samples: some View {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 20) {
          ForEach(GallerySample.shown) { sample in
            Section {
              ForEach(Presentation.allCases, id: \.self) { presentation in
                VStack(alignment: .leading, spacing: 6) {
                  Text(presentation.rawValue)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                  TranscriptItemView(row: sample.row(presentation))
                }
              }
            } header: {
              Text(sample.title)
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
                .accessibilityAddTraits(.isHeader)
            }
          }
        }
        .padding(16)
        .frame(maxWidth: width.points ?? .infinity)
        .frame(maxWidth: .infinity)
      }
      .environment(\.transcriptExpansion, expansion)
      .environment(\.transcriptOwnAuthorID, "telegram:1")
      .environment(\.transcriptItemActions, actions)
      .transformEnvironment(\.dynamicTypeSize) { size in
        if largeText { size = .accessibility5 }
      }
    }

    private var actions: TranscriptItemActions {
      let log = $log
      return TranscriptItemActions(
        answerApproval: { item, choice in log.wrappedValue = "approval \(item.id): \(choice)" },
        answerClarify: { item, answers in
          log.wrappedValue = "clarify \(item.id): \(answers.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", "))"
        },
        openBotChat: { handle in log.wrappedValue = "open @\(handle)" },
        retry: { item in log.wrappedValue = "retry \(item.id)" },
        openAttachment: { reference in log.wrappedValue = "open \(reference)" }
      )
    }

    private var controls: some View {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          pickers
          Spacer(minLength: 0)
        }
        .pickerStyle(.menu)
        Toggle("AX5", isOn: $largeText)
          .accessibilityIdentifier("gallery.ax5")
        Text(log)
          .font(.caption.monospaced())
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("gallery.log")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(.background)
    }

    @ViewBuilder private var pickers: some View {
      Picker("Scheme", selection: $scheme) {
        Text("System").tag(ColorScheme?.none)
        Text("Light").tag(ColorScheme?.some(.light))
        Text("Dark").tag(ColorScheme?.some(.dark))
      }
      Picker("Width", selection: $width) {
        ForEach(GalleryWidth.allCases) { Text($0.rawValue).tag($0) }
      }
    }
  }

  /// One gallery entry: an item, drawn in each presentation.
  struct GallerySample: Identifiable {
    let id: String
    let title: String
    let item: TranscriptItem

    func row(_ presentation: Presentation) -> TranscriptRow {
      var row = TranscriptRow(VisibleItem(item: item, presentation: presentation))
      // Distinct ids per presentation, so disclosures and render counts do not mix.
      row = TranscriptRow(id: "\(id).\(presentation.rawValue)", content: row.content)
      return row
    }

    /// `all`, or only the samples whose title starts with the launch argument
    /// `-HermieGallerySample` (the UI tests use it to get one card on screen).
    static var shown: [GallerySample] {
      guard let prefix = UserDefaults.standard.string(forKey: "HermieGallerySample"), !prefix.isEmpty else { return all }
      return all.filter { $0.title.hasPrefix(prefix) }
    }

    static let all: [GallerySample] = {
      var g = SyntheticTranscript(seed: 7)
      var samples: [GallerySample] = []
      func add(_ title: String, _ item: TranscriptItem) {
        samples.append(GallerySample(id: "g\(samples.count)", title: title, item: item))
      }
      add("User", g.user(seq: 1, author: nil))
      add("User, shared chat", g.user(seq: 2, author: MessageAuthor(id: "telegram:42", name: "Robin")))
      var pending = g.user(seq: 3)
      pending.updateUser {
        $0.pending = true
        $0.author = nil
        $0.attachments = ["@file:/Users/robin/Documents/quarterly-report-final-v2.pdf", "@image:/tmp/photo.jpg"]
      }
      add("User, pending with attachments", pending)
      add("Assistant", g.assistant(seq: 4))
      var streaming = g.assistant(seq: 5)
      streaming.updateAssistant {
        $0.streaming = true
        $0.reasoning = "Weighing the two options before answering."
        $0.text = "Writing the answer"
        $0.usage = nil
      }
      add("Assistant, streaming with a thought", streaming)
      var failed = g.assistant(seq: 6)
      failed.updateAssistant {
        $0.error = AssistantFailure(message: "The model provider timed out.", partial: true)
        $0.status = .error
      }
      add("Assistant, failed", failed)
      add("Tool, complete", g.tool(seq: 7))
      add("Tool, running", g.tool(seq: 8, status: .running))
      var patch = g.tool(seq: 9)
      patch.updateTool {
        $0.name = "patch"
        $0.inlineDiff = "--- a/App.swift\n+++ b/App.swift\n-let size = 12\n+let size = 14\n struct App {}"
        $0.outputRisk = ToolOutputRisk(risk: "medium", findings: ["Looks like an instruction to the model"], redacted: true)
      }
      add("Tool, patch with risk", patch)
      add("Status", g.status(seq: 10))
      add("Notice, command", g.notice(seq: 11, kind: .command))
      add("Notice, model switch", g.notice(seq: 12, kind: .modelSwitch))
      add("Notice, process complete", g.notice(seq: 13, kind: .processComplete))
      add("Notice, error", g.notice(seq: 14, kind: .error))
      add("Notice, reclaimed", g.notice(seq: 15, kind: .reclaimed))
      add("Bot to bot, outbound", g.botDm(seq: 16, outbound: true))
      add("Bot to bot, inbound", g.botDm(seq: 17, outbound: false))
      add("Cron delivery", g.cron(seq: 18))
      add("Cron delivery, redacted name", g.cron(seq: 19, redacted: true))
      add("Subagents, running", g.subagents(seq: 20, status: .running))
      add("Subagents, done", g.subagents(seq: 21))
      add("Approval, open", g.approval(seq: 22, state: .open))
      add("Approval, denied", g.approval(seq: 23, state: .answered, answer: "deny"))
      add("Clarify, open", g.clarify(seq: 24, state: .open))
      add("Clarify, answered", g.clarify(seq: 25, state: .answered))
      add("Unknown kind", .unknown(UnknownItem(kindName: "poll", base: ItemBase(id: "x", seq: 26, origin: .live, version: 1))))
      return samples
    }()
  }

  extension DebugScreens {
    /// Puts the transcript lab and the item gallery in Settings → Advanced.
    /// The app calls it once at launch, in a debug build.
    public static func registerTranscriptScreens() {
      register(id: "transcript-lab", title: "Transcript lab") { TranscriptLabView() }
      register(id: "transcript-gallery", title: "Transcript item gallery") { TranscriptItemGallery() }
    }
  }

  /// The debug screens, for the app shells to link from a debug menu.
  public struct TranscriptDebugMenu: View {
    public init() {}

    public var body: some View {
      List {
        NavigationLink("Transcript lab") { TranscriptLabView() }
          .accessibilityIdentifier("debug.lab")
        NavigationLink("Item gallery") { TranscriptItemGallery() }
          .accessibilityIdentifier("debug.gallery")
        NavigationLink("Composer lab") { ComposerLabView() }
          .accessibilityIdentifier("debug.composer")
      }
      .navigationTitle("Transcript")
    }
  }

  #Preview("Gallery") {
    NavigationStack { TranscriptItemGallery() }
  }

  #Preview("Gallery, AX5, dark") {
    NavigationStack { TranscriptItemGallery() }
      .dynamicTypeSize(.accessibility5)
      .preferredColorScheme(.dark)
  }

  #Preview("Lab") {
    NavigationStack { TranscriptLabView() }
  }
#endif
