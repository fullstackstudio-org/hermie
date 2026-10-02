#if DEBUG
  import HermieCore
  import HermieGateway
  import HermieStore
  import HermieTranscript
  import SwiftUI

  /// The composer and the request answering against a live gateway, as a
  /// debug screen: one chat's transcript with the real `ComposerView`, the
  /// approval and clarify cards answered through `RequestsModel`, and the
  /// request sheet. The UI tests drive it against the fake gateway, so they do
  /// not depend on the chat screen.
  ///
  /// Launch arguments: `-HermieLabGateway <address>` (required; for the fake
  /// gateway `http://127.0.0.1:<port>`), `-HermieLabBot <name>` (default
  /// `researcher`), `-HermieLabToken <token>` for a gateway that wants one, and
  /// `-HermieLabHideTranscript YES` to leave the rows out.
  /// Nothing is written to disk and the keychain is never touched.
  public struct ComposerLabView: View {
    @State private var model = ComposerLabModel()

    public init() {}

    public var body: some View {
      content
        .task { await model.start() }
        .navigationTitle(model.bot)
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder private var content: some View {
      if let composer = model.composer, let requests = model.requests, let chat = model.chat {
        ComposerLabTranscript(model: model, chat: chat)
          .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
              RequestNoticeView(requests: requests)
                .padding(.horizontal, 12)
              ComposerView(model: composer)
            }
          }
          .answeringRequests(with: requests)
      } else {
        ContentUnavailableView {
          Label("Composer lab", systemImage: "text.bubble")
        } description: {
          Text(model.status)
            .accessibilityIdentifier("composerLab.status")
        }
      }
    }
  }

  /// The transcript, rebuilt from the chat's snapshot whenever it moves on.
  private struct ComposerLabTranscript: View {
    let model: ComposerLabModel
    let chat: ChatModel

    var body: some View {
      if model.hidesTranscript {
        Color.clear
      } else {
        TranscriptList(model.rows, state: model.listState) { row in
          TranscriptItemView(row: row)
            .padding(.horizontal, 16)
        }
        .onChange(of: chat.snapshot?.revision, initial: true) {
          model.rebuildRows()
        }
      }
    }
  }

  @MainActor
  @Observable
  final class ComposerLabModel {
    var status = "Starting…"
    var rows = TranscriptListItems<TranscriptRow>()
    private(set) var chat: ChatModel?
    private(set) var composer: ComposerModel?
    private(set) var requests: RequestsModel?

    @ObservationIgnored let listState = TranscriptListState()
    /// `-HermieLabHideTranscript YES`: the rows are not drawn, for an
    /// accessibility audit of the composer and the sheet alone (the rows have
    /// their own, over the item gallery).
    @ObservationIgnored let hidesTranscript = UserDefaults.standard.bool(forKey: "HermieLabHideTranscript")
    @ObservationIgnored let bot = UserDefaults.standard.string(forKey: "HermieLabBot") ?? "researcher"
    @ObservationIgnored private var session: GatewaySession?
    @ObservationIgnored private var builder = TranscriptRowBuilder()

    func start() async {
      guard session == nil else {
        return
      }

      guard let address = UserDefaults.standard.string(forKey: "HermieLabGateway"), !address.isEmpty else {
        status = "Launch with -HermieLabGateway http://127.0.0.1:<port> (npm run fake-gateway)."
        return
      }

      do {
        let record = GatewayRecord(id: "glab", name: "Lab", address: address, authKind: .sessionToken, addedAt: 0)
        let token = UserDefaults.standard.string(forKey: "HermieLabToken") ?? ""
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: token),
          database: try SQLiteStore(.inMemory)
        )
        self.session = session
        status = "Connecting to \(address)…"
        await session.start()

        try await waitFor("the gateway and \(bot)") {
          session.status.phase == .ready && session.chatList.rows[self.bot] != nil
        }

        chat = session.chat(bot)
        composer = ComposerModel(session: session, bot: bot)
        requests = RequestsModel(session: session, bot: bot)
        try await session.open(bot)
      } catch {
        status = "Could not open \(bot): \(error)"
      }
    }

    func rebuildRows() {
      guard let chat else {
        return
      }

      rows = TranscriptListItems(builder.rows(for: chat.items))
    }

    private func waitFor(_ what: String, _ condition: () -> Bool) async throws {
      let deadline = ContinuousClock.now + .seconds(30)

      while !condition() {
        guard ContinuousClock.now < deadline else {
          throw ComposerLabTimeout(what: what)
        }

        try await Task.sleep(for: .milliseconds(50))
      }
    }
  }

  private struct ComposerLabTimeout: Error, CustomStringConvertible {
    var what: String
    var description: String { "timed out waiting for \(what)" }
  }

  extension DebugScreens {
    /// Puts the composer lab in Settings → Advanced.
    public static func registerComposerScreens() {
      register(id: "composer-lab", title: "Composer lab") { ComposerLabView() }
    }
  }
#endif
