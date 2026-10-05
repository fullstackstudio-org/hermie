#if os(macOS)
  import AppKit
  import HermieCore
  import HermieTranscript
  import SwiftUI

  /// Turns the items of a quick ask's exchange into the transcript's own rows, keeping the builder
  /// between frames so a streamed reply parses its tail and not the whole reply again.
  @MainActor
  final class QuickAskRows {
    private var builder = TranscriptRowBuilder()

    func rows(for items: [VisibleItem]) -> [TranscriptRow] {
      builder.rows(for: items, historyComplete: false)
    }
  }

  /**
   The quick ask's window: the bot it goes to, "Open in Hermie", the answer as it streams in, and the
   chat's own composer.

   The answer is the transcript's own rows (`TranscriptItemView`), so a reply reads as it does in the
   chat: Markdown, code, links. The field is the chat's own composer (`ComposerView`): Return sends,
   Shift-Return starts a new line, a paperclip and a paste take attachments, and what is sent is a
   message in the bot's normal chat.

   Files, pictures and words dropped on the window go into the message (`QuickAskDrop`).
   */
  struct QuickAskView: View {
    let system: QuickAskSystem

    @Environment(AppLaunch.self) private var launch: AppLaunch?
    @State private var rows = QuickAskRows()
    @State private var answerHeight: CGFloat = 0
    @FocusState private var pickerFocused: Bool

    /// The window is this wide, in the menu bar and as a panel.
    static let width: CGFloat = 400
    /// The answer grows with its words, up to this high, and scrolls after that.
    static let answerLimit: CGFloat = 320

    private var model: QuickAskModel { system.model }

    var body: some View {
      VStack(alignment: .leading, spacing: 0) {
        header
        content
      }
      .frame(width: Self.width)
      .task(id: model.syncKey) {
        model.sync()
      }
      .quickAskDropTarget(model: model)
      .onExitCommand { system.presenter.hide() }
      .onAppear { applyFocus() }
      .onChange(of: model.focusSerial) { applyFocus() }
      .onChange(of: model.composer != nil) { applyFocus() }
      // The menu bar's window is the same view each time it opens: the caret goes where it was asked for.
      .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
        applyFocus()
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel(NativeStrings.QuickAsk.title)
    }

    // MARK: Focus

    private func applyFocus() {
      switch model.focus {
      case .field:
        pickerFocused = false
        model.composer?.requestFocus()
      case .botPicker:
        pickerFocused = true
      }
    }

    // MARK: The header

    private var header: some View {
      HStack(spacing: 8) {
        Text(NativeStrings.QuickAsk.bot)
          .foregroundStyle(.secondary)

        Picker(NativeStrings.QuickAsk.bot, selection: bot) {
          ForEach(model.choices) { choice in
            Text(choice.title).tag(choice.id)
          }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .fixedSize()
        .focused($pickerFocused)
        .disabled(model.choices.isEmpty)
        .accessibilityIdentifier("hermie.quickAsk.bot")

        Spacer(minLength: 8)

        Button {
          system.presenter.openInHermie()
        } label: {
          Label(NativeStrings.QuickAsk.openInHermie, systemImage: "arrow.up.forward.app")
        }
        .buttonStyle(.borderless)
        .help(NativeStrings.QuickAsk.openInHermieHint)
        .accessibilityHint(NativeStrings.QuickAsk.openInHermieHint)
        .accessibilityIdentifier("hermie.quickAsk.open")
      }
      .padding(.horizontal, 14)
      .padding(.top, 12)
      .padding(.bottom, 8)
    }

    /// The bot's choice: picking one sends the caret to the field, where the words go next.
    private var bot: Binding<String> {
      Binding(
        get: { model.selectedBot ?? "" },
        set: { chosen in
          model.select(chosen)
          pickerFocused = false
          model.composer?.requestFocus()
        })
    }

    // MARK: The rest

    @ViewBuilder private var content: some View {
      if model.session == nil {
        note(NativeStrings.QuickAsk.noGateway)
      } else if let composer = model.composer {
        VStack(alignment: .leading, spacing: 0) {
          if let failure = model.openFailure {
            openFailure(failure)
          }

          answer

          ComposerView(model: composer)
        }
      } else if model.choices.isEmpty, model.session?.chatList.loading != true {
        note(NativeStrings.QuickAsk.noBots)
      } else {
        ProgressView()
          .controlSize(.small)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 24)
      }
    }

    private func note(_ text: String) -> some View {
      Text(text)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.leading)
        .padding(.horizontal, 14)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func openFailure(_ reason: String) -> some View {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(NativeStrings.QuickAsk.openFailed(reason), systemImage: "exclamationmark.triangle")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)

        Button(Strings.App.Common.retry) {
          model.retryOpen()
        }
        .buttonStyle(.borderless)
        .font(.footnote)
      }
      .padding(.horizontal, 14)
      .padding(.bottom, 8)
    }

    // MARK: The answer

    @ViewBuilder private var answer: some View {
      let stage = model.stage

      if stage != .composing {
        let built = rows.rows(for: model.exchange)

        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(built) { row in
              TranscriptItemView(row: row, gaps: .chat)
                .padding(.horizontal, 14)
            }

            // The bot has not said anything yet: its three dots, where the reply will be.
            if stage == .sending || stage == .waiting {
              TranscriptItemView(row: TranscriptRowBuilder.typingIndicatorRow(), gaps: .chat)
                .padding(.horizontal, 14)
                .accessibilityLabel(NativeStrings.QuickAsk.waiting(for: botTitle))
            }
          }
          .padding(.vertical, 8)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { answerHeight = $0 }
        }
        .defaultScrollAnchor(.bottom)
        .frame(height: min(answerHeight, Self.answerLimit))
        .transcriptTextSize(launch?.settings.synced.textSize ?? .standard)
        .accessibilityIdentifier("hermie.quickAsk.answer")
      }
    }

    /// The name of the bot being asked, as the picker shows it.
    private var botTitle: String {
      model.choices.first { $0.id == model.selectedBot }?.title ?? model.selectedBot ?? ""
    }
  }
#endif
