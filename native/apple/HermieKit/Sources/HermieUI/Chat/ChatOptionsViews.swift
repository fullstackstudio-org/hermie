import HermieCore
import HermieTranscript
import SwiftUI

// The per-chat options beyond YOLO mode, in the chat's `…` menu: fast mode, reasoning effort, the
// model, the context meter and the export. The state is `ChatFeed.sessionOptions`; nothing here
// asks the gateway except through the feed.

/// What the menu lists for the reasoning effort, with the gateway's own word kept when it is not one
/// of ours.
enum ReasoningEffortChoice: Equatable, Identifiable {
  static let known = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

  case effort(String)

  var id: String { value }

  var value: String {
    switch self {
    case .effort(let value): value
    }
  }

  var label: String { Self.label(value) }

  static func label(_ effort: String) -> String {
    NativeStrings.Chat.Reasoning.label(effort) ?? effort
  }

  /// The levels, with the session's own listed too when it is not a known one.
  static func choices(including current: String?) -> [ReasoningEffortChoice] {
    var values = known

    if let current, !current.isEmpty, !values.contains(current.lowercased()) {
      values.append(current)
    }

    return values.map(ReasoningEffortChoice.effort)
  }
}

/// The reasoning effort's line in the chat's `…` menu, as data: one submenu that lists the levels
/// directly, the session's own marked, and nothing nested inside it (HERM-257: the line opened a
/// submenu whose only child was another "Reasoning effort" submenu).
struct ReasoningEffortMenu: Equatable {
  /// One level the submenu lists.
  struct Entry: Equatable, Identifiable {
    let choice: ReasoningEffortChoice
    /// The session's level: drawn with a checkmark.
    let isCurrent: Bool

    var id: String { choice.id }
  }

  /// The submenu's line: the name, and the session's level after it when it has one.
  let title: String
  /// The levels, in the order they are listed.
  let entries: [Entry]

  init(current: String?) {
    title =
      current.map { "\(Strings.Chat.Options.reasoning): \(ReasoningEffortChoice.label($0))" }
      ?? Strings.Chat.Options.reasoning
    entries = ReasoningEffortChoice.choices(including: current).map { choice in
      Entry(choice: choice, isCurrent: current == choice.value)
    }
  }
}

/// How a token count reads on the context row: thousands past a thousand and millions past a
/// million, one decimal only where it changes the reading (`formatTokens` of the Expo app).
enum ContextFormat {
  static func tokens(_ count: Double) -> String {
    if count < 1000 {
      return String(Int(count.rounded()))
    }

    if count < 1_000_000 {
      return "\(Int((count / 1000).rounded()))k"
    }

    let millions = count / 1_000_000
    return millions < 10 ? String(format: "%.1fM", millions) : "\(Int(millions.rounded()))M"
  }

  /// `Context used: 25% · 50k / 200k`, and ` (estimated)` when the gateway says the count is.
  static func line(_ usage: ContextUsage) -> String {
    var line =
      "\(Strings.Chat.Context.label): \(Strings.Chat.Context.percent(percent: Int(usage.percent))) · "
      + Strings.Chat.Context.counts(used: tokens(usage.used), limit: tokens(usage.limit))

    if usage.estimated {
      line += " \(Strings.Chat.Context.estimated)"
    }

    return line
  }

  /// Where the toolbar's ring starts to show: before that the window has room, and the menu's row
  /// says it for anyone who looks.
  static let warnAt = 0.75
  static let dangerAt = 0.9
}

/// The menu's items for the options a session has: shown only while the chat is attached.
struct ChatSessionOptionItems: View {
  let feed: ChatFeed

  var body: some View {
    let options = feed.sessionOptions

    Toggle(isOn: Binding(get: { options.fast }, set: { feed.setFast($0) })) {
      Label(Strings.Chat.Options.fast, systemImage: "hare.fill")
    }
    .accessibilityHint(Strings.Chat.Options.fastHint)
    .accessibilityIdentifier("hermie.chat.options.fast")

    // One submenu with the levels listed in it directly: an inline picker draws them as the menu's
    // own lines with a checkmark on the current one, where a plain picker here is a second submenu.
    let reasoning = ReasoningEffortMenu(current: options.reasoningEffort)

    Menu {
      Picker(
        Strings.Chat.Options.reasoning,
        selection: Binding<String?>(
          get: { options.reasoningEffort }, set: { if let effort = $0 { feed.setReasoningEffort(effort) } })
      ) {
        ForEach(reasoning.entries) { entry in
          Text(entry.choice.label).tag(Optional(entry.choice.value))
        }
      }
      .pickerStyle(.inline)
      .labelsHidden()
    } label: {
      Label(reasoning.title, systemImage: "brain")
    }
    .accessibilityIdentifier("hermie.chat.options.reasoning")

    Button {
      feed.openModelPicker()
    } label: {
      Label(
        options.model.map { "\(Strings.Chat.Options.model): \($0)" } ?? Strings.Chat.Options.model,
        systemImage: "cpu")
    }
    .accessibilityIdentifier("hermie.chat.options.model")

    if let usage = options.contextUsage {
      // A fact to check the choices above against, not a control.
      Label(ContextFormat.line(usage), systemImage: "gauge.with.needle")
        .accessibilityHint(Strings.Chat.Context.hint)
        .accessibilityIdentifier("hermie.chat.options.context")
    }

    Menu {
      Button(NativeStrings.Chat.Options.exportMarkdown) { feed.export(.markdown) }
        .accessibilityIdentifier("hermie.chat.options.export.markdown")
      Button(NativeStrings.Chat.Options.exportText) { feed.export(.text) }
        .accessibilityIdentifier("hermie.chat.options.export.text")
    } label: {
      Label(Strings.Chat.Export.header, systemImage: "square.and.arrow.up")
    }
    .accessibilityHint(Strings.Chat.Export.hint)
    .accessibilityIdentifier("hermie.chat.options.export")
  }
}

/// A small ring in the toolbar while the context window is nearly full: subtle, and gone while there
/// is room. The percentage and counts are in the options menu.
struct ContextRing: View {
  let usage: ContextUsage

  static func shows(_ usage: ContextUsage?) -> Bool {
    (usage?.fraction ?? 0) >= ContextFormat.warnAt
  }

  private var tint: Color {
    usage.fraction >= ContextFormat.dangerAt ? .red : .orange
  }

  var body: some View {
    ZStack {
      Circle().stroke(.quaternary, lineWidth: 3)
      Circle()
        .trim(from: 0, to: usage.fraction)
        .stroke(tint, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .frame(width: 18, height: 18)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(NativeStrings.Chat.Options.contextBadge)
    .accessibilityValue(Strings.Chat.Context.percent(percent: Int(usage.percent)))
    .accessibilityIdentifier("hermie.chat.context")
  }
}

/// The models grouped by provider, in the gateway's order, filtered by the search words.
struct ModelPickerSection: Equatable, Identifiable {
  var id: String
  var name: String
  var choices: [BotModelChoice]

  static func sections(_ choices: [BotModelChoice], matching query: String) -> [ModelPickerSection] {
    let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
    var sections: [ModelPickerSection] = []

    for choice in choices {
      guard
        words.isEmpty || choice.model.localizedCaseInsensitiveContains(words)
          || choice.providerName.localizedCaseInsensitiveContains(words)
      else {
        continue
      }

      if let index = sections.firstIndex(where: { $0.id == choice.provider }) {
        sections[index].choices.append(choice)
      } else {
        sections.append(ModelPickerSection(id: choice.provider, name: choice.providerName, choices: [choice]))
      }
    }

    return sections
  }
}

/// This chat's model, chosen from the gateway's own list. Choosing one closes the list and asks the
/// gateway; a model it calls expensive is confirmed by an alert on the chat, never here.
struct ModelPickerSheet: View {
  let feed: ChatFeed

  @State private var query = ""

  var body: some View {
    NavigationStack {
      content
        .navigationTitle(Strings.Chat.Options.model)
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(Strings.App.Common.cancel) { feed.showingModelPicker = false }
          }
        }
    }
    .searchable(text: $query, prompt: Strings.Chat.Options.modelSearch)
    #if os(macOS)
      .frame(minWidth: 380, minHeight: 460)
    #endif
    .accessibilityIdentifier("hermie.chat.modelPicker")
  }

  @ViewBuilder
  private var content: some View {
    switch feed.modelList {
    case .idle, .loading:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let reason):
      VStack(spacing: 12) {
        Text(NativeStrings.Chat.Options.modelsFailed(reason))
          .multilineTextAlignment(.center)
        Button(Strings.App.Common.retry) { feed.loadModels() }
      }
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loaded(let choices):
      let sections = ModelPickerSection.sections(choices, matching: query)

      if choices.isEmpty {
        Text(NativeStrings.Chat.Options.modelsEmpty)
          .multilineTextAlignment(.center)
          .padding()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if sections.isEmpty {
        Text(NativeStrings.Chat.Options.modelsEmptySearch)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List {
          ForEach(sections) { section in
            Section(section.name) {
              ForEach(section.choices) { choice in
                row(choice)
              }
            }
          }
        }
      }
    }
  }

  private func row(_ choice: BotModelChoice) -> some View {
    let current = choice.isCurrent(model: feed.sessionOptions.model, provider: feed.sessionOptions.provider)

    return Button {
      feed.chooseModel(choice)
    } label: {
      HStack {
        Text(choice.model)
        Spacer()
        if current {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(current ? .isSelected : [])
  }
}

/// What the options put over the chat: the model list, the alert that asks before an expensive
/// model, and the system's save sheet for an export.
struct ChatOptionsPresentations: ViewModifier {
  let owner: ChatFeedOwner<ChatFeed>

  func body(content: Content) -> some View {
    content
      .sheet(
        isPresented: Binding(
          get: { owner.feed?.showingModelPicker ?? false }, set: { owner.feed?.showingModelPicker = $0 })
      ) {
        if let feed = owner.feed {
          ModelPickerSheet(feed: feed)
        }
      }
      // The gateway calls the model expensive: nothing was written, and only a yes sends it again.
      .alert(
        Strings.Chat.Options.expensiveTitle,
        isPresented: Binding(
          get: { owner.feed?.pendingModel != nil }, set: { if !$0 { owner.feed?.cancelPendingModel() } }),
        presenting: owner.feed?.pendingModel
      ) { pending in
        Button(Strings.Chat.Options.expensiveConfirm) { owner.feed?.confirmModel(pending) }
          .accessibilityIdentifier("hermie.chat.model.confirm")
        Button(Strings.Chat.Options.cancel, role: .cancel) {}
      } message: { pending in
        Text(pending.message ?? NativeStrings.Chat.Options.expensiveFallback)
      }
      .fileExporter(
        isPresented: Binding(get: { owner.feed?.exporting ?? false }, set: { owner.feed?.exporting = $0 }),
        document: TranscriptDocument(text: owner.feed?.exportFile?.content ?? ""),
        contentType: owner.feed?.exportFile?.format.contentType ?? .plainText,
        defaultFilename: owner.feed?.exportFile?.name
      ) { result in
        owner.feed?.exportFinished(result)
      }
  }
}
