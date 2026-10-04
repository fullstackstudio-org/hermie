import HermieCore
import SwiftUI

/**
 Settings → Memory: what each bot remembers (`MemoryBotsScreen` and `MemoryScreen` in the Expo app).

 The first page lists the bots of the live gateway; one bot's page holds its two files, MEMORY.md and
 USER.md, as entries with how full each file is, a search over both, and the raw side (each file as
 it is stored, and what the other memory backends say they hold). Where the gateway lets memory be
 changed, an entry is edited in a sheet and removed after a confirmation, and an entry is added from
 the field under its file; where it lets memory be read and not written, the page says so and offers
 no control that could only fail.

 Memory is a plugin's: a gateway without the Hermie plugin (or with its memory browser switched off)
 gets one explanation instead of a page. Every text here is the gateway's or a bot's, drawn as plain
 text.
 */
struct MemorySettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.memory.page") { session in
      MemoryBotsPage(session: session)
    }
  }
}

/// The bots to pick from.
struct MemoryBotsPage: View {
  let session: GatewaySession

  var body: some View {
    let bots = session.capabilityBots

    Form {
      if bots.isEmpty {
        Section {
          CapabilityStatusRow(text: Strings.Memory.botsEmpty, symbol: "person.2.slash")
        }
      } else {
        Section {
          ForEach(bots) { bot in
            NavigationLink {
              MemoryBotPage(session: session, bot: bot)
            } label: {
              Text(verbatim: bot.name)
            }
            .accessibilityIdentifier("hermie.memory.bot.\(bot.id)")
          }
        } header: {
          SettingsNote(Strings.Memory.botsHint)
        }
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.memory.bots")
  }
}

/// Which side of a bot's memory is on screen.
enum MemoryTab: Hashable, CaseIterable {
  case entries
  case raw

  var title: String {
    switch self {
    case .entries: Strings.Memory.Tabs.entries
    case .raw: Strings.Memory.Tabs.raw
    }
  }
}

/// One bot's memory.
struct MemoryBotPage: View {
  let session: GatewaySession
  let bot: CapabilityBot

  @State private var model: MemoryModel?
  @State private var tab = MemoryTab.entries
  @State private var text = ""
  @State private var editing: MemoryEntry?
  @State private var removing: MemoryEntry?

  init(session: GatewaySession, bot: CapabilityBot) {
    self.session = session
    self.bot = bot
    _model = State(initialValue: session.memory(for: bot.id))
  }

  var body: some View {
    Group {
      if let model {
        content(model)
      } else {
        Form {
          Section { CapabilityStatusRow(text: NativeStrings.Capability.noGateway, symbol: "nosign") }
        }
        .formStyle(.grouped)
      }
    }
    .navigationTitle(Strings.Memory.forBot(name: bot.name))
    .accessibilityIdentifier("hermie.memory.page")
  }

  private func content(_ model: MemoryModel) -> some View {
    let availability = session.memoryAvailability

    return Form {
      CapabilityNoticeSection(text: noticeText(model.notice), dismiss: model.dismissNotice)
      stateSection(model, availability: availability)

      if model.phase == .ready, availability.canRead {
        Section {
          Picker(Strings.Memory.title, selection: $tab) {
            ForEach(MemoryTab.allCases, id: \.self) { tab in
              Text(verbatim: tab.title).tag(tab)
            }
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .accessibilityIdentifier("hermie.memory.tabs")
        }

        switch tab {
        case .entries:
          entriesTab(model)
        case .raw:
          MemoryRawTab(model: model)
        }
      }
    }
    .formStyle(.grouped)
    .searchable(text: $text, prompt: Strings.Memory.Search.placeholder)
    .task(id: ObjectIdentifier(model)) { await model.load() }
    .task(id: availability) { model.setAvailability(availability) }
    .task(id: text) {
      // A burst of typing is one search: the last keystroke's, after a short pause. Clearing the
      // field answers at once.
      if !text.isEmpty {
        try? await Task.sleep(for: .milliseconds(300))
      }

      if !Task.isCancelled {
        await model.search(text)
      }
    }
    .task(id: tab) {
      if tab == .raw, model.raw == .idle {
        await model.loadRaw()
      }
    }
    .refreshable {
      await model.load()

      if tab == .raw {
        await model.loadRaw()
      }
    }
    .sheet(item: $editing) { entry in
      MemoryEntryEditor(model: model, entry: entry)
    }
    .confirmationDialog(
      Strings.Memory.Remove.confirmTitle,
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible,
      presenting: removing
    ) { entry in
      Button(Strings.Memory.Remove.confirm, role: .destructive) {
        Task { await model.remove(entry) }
      }
      .accessibilityIdentifier("hermie.memory.remove.confirm")
      Button(Strings.Memory.Remove.cancel, role: .cancel) {}
    } message: { _ in
      Text(Strings.Memory.Remove.confirmBody)
    }
  }

  private func noticeText(_ notice: MemoryModel.Notice?) -> String? {
    switch notice {
    case .words(let words): words
    case .editSwitchedOff: Strings.Memory.readOnly
    case nil: nil
    }
  }

  // MARK: States

  @ViewBuilder private func stateSection(_ model: MemoryModel, availability: MemoryAvailability) -> some View {
    switch (availability, model.phase) {
    case (.unknown, _):
      Section { CapabilityLoadingRow(text: Strings.Memory.Missing.unknown) }
    case (.missing, _), (_, .missing), (_, .switchedOff):
      MemoryMissingSection()
    case (_, .loading):
      Section { CapabilityLoadingRow(text: Strings.Memory.loading) }
    case (_, .failed(let words)):
      Section { CapabilityFailureRow(text: Strings.Memory.failed(reason: words)) { Task { await model.load() } } }
    case (.readOnly, .ready):
      Section { CapabilityStatusRow(text: Strings.Memory.readOnly, symbol: "lock") }
    case (.editable, .ready):
      EmptyView()
    }
  }

  // MARK: Entries

  @ViewBuilder private func entriesTab(_ model: MemoryModel) -> some View {
    if model.isSearching {
      searchSection(model)
    } else {
      ForEach(model.listing?.sections ?? []) { section in
        fileSection(section, model: model)
      }

      let external = model.listing?.externalProviders ?? []

      if !external.isEmpty {
        Section {
          ForEach(external) { provider in
            LabeledContent {
              Text(Strings.Memory.Providers.notBrowsable)
            } label: {
              Text(verbatim: provider.description.isEmpty ? provider.name : provider.description)
            }
            .accessibilityElement(children: .combine)
          }
        } header: {
          SettingsNote(Strings.Memory.Providers.header)
        } footer: {
          SettingsNote(Strings.Memory.Providers.hint)
        }
      }
    }
  }

  private func fileSection(_ section: MemorySection, model: MemoryModel) -> some View {
    Section {
      MemoryUsageBar(section: section)

      if section.entries.isEmpty {
        Text(section.target == .memory ? Strings.Memory.Empty.memory : Strings.Memory.Empty.user)
          .foregroundStyle(Color.primary)
          .accessibilityIdentifier("hermie.memory.empty.\(section.target.rawValue)")
      }

      ForEach(section.entries) { entry in
        entryRow(entry, model: model)
      }

      if model.canWrite {
        MemoryAddRow(target: section.target, model: model)
      }
    } header: {
      SettingsNote(section.target == .memory ? Strings.Memory.Sections.memory : Strings.Memory.Sections.user)
    } footer: {
      SettingsNote(section.target == .memory ? Strings.Memory.SectionHint.memory : Strings.Memory.SectionHint.user)
    }
  }

  @ViewBuilder private func searchSection(_ model: MemoryModel) -> some View {
    Section {
      switch model.search {
      case .idle, .searching:
        CapabilityLoadingRow(text: Strings.Memory.Search.searching)
      case .failed(let words):
        CapabilityFailureRow(text: Strings.Memory.failed(reason: words)) { Task { await model.search(text) } }
      case .results(let answer):
        if answer.results.isEmpty {
          Text(Strings.Memory.Search.none(query: answer.query))
            .foregroundStyle(Color.primary)
            .accessibilityIdentifier("hermie.memory.search.none")
        } else {
          ForEach(answer.results) { entry in
            entryRow(entry, model: model, showsTarget: true)
          }
        }
      }
    } header: {
      if case .results(let answer) = model.search, !answer.results.isEmpty {
        SettingsNote(Strings.Memory.Search.count(found: answer.results.count))
      }
    } footer: {
      SettingsNote(Strings.Memory.Search.hint)
    }
  }

  private func entryRow(_ entry: MemoryEntry, model: MemoryModel, showsTarget: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if showsTarget {
        Text(verbatim: entry.target.fileName)
          .font(.footnote)
          .foregroundStyle(Color.primary)
      }

      Text(verbatim: entry.text)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
    .accessibilityElement(children: .combine)
    .accessibilityActions {
      if model.canWrite {
        Button(Strings.Memory.Edit.label(index: entry.index)) { editing = entry }
        Button(Strings.Memory.Remove.label(index: entry.index)) { removing = entry }
      }
    }
    .contextMenu {
      if model.canWrite {
        Button(Strings.Memory.Edit.action, systemImage: "pencil") { editing = entry }
        Button(Strings.Memory.Remove.action, systemImage: "trash", role: .destructive) { removing = entry }
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if model.canWrite {
        Button(role: .destructive) {
          removing = entry
        } label: {
          Label(Strings.Memory.Remove.action, systemImage: "trash")
        }

        Button {
          editing = entry
        } label: {
          Label(Strings.Memory.Edit.action, systemImage: "pencil")
        }
        .tint(.orange)
      }
    }
    .accessibilityIdentifier("hermie.memory.entry.\(entry.id)")
  }
}

/// Why there is no memory page for this gateway: the plugin is absent, too old, or has the memory
/// browser off.
struct MemoryMissingSection: View {
  var body: some View {
    Section {
      CapabilityStatusRow(text: Strings.Memory.Missing.title, symbol: "puzzlepiece.extension")

      Text(Strings.Memory.Missing.body)
        .foregroundStyle(Color.primary)
        .fixedSize(horizontal: false, vertical: true)
    } footer: {
      SettingsNote(Strings.Memory.Raw.missingHint + " " + Strings.Memory.Raw.missingCommand)
    }
    .accessibilityIdentifier("hermie.memory.missing")
  }
}

/// How full a file is, as a bar with the numbers beside it and read as one sentence.
struct MemoryUsageBar: View {
  let section: MemorySection

  var body: some View {
    let name = section.target.fileName

    VStack(alignment: .leading, spacing: 6) {
      if let fraction = section.fraction {
        ProgressView(value: fraction)
          .tint(fraction >= 0.9 ? .orange : .accentColor)
        Text(Strings.Memory.usage(chars: section.chars, limit: section.limit))
          .font(.footnote)
          .foregroundStyle(Color.primary)
      } else {
        Text(Strings.Memory.usageUnbounded(chars: section.chars))
          .font(.footnote)
          .foregroundStyle(Color.primary)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      section.fraction == nil
        ? Strings.Memory.usageUnbounded(chars: section.chars)
        : Strings.Memory.usageLabel(target: name, percent: section.spokenPercent)
    )
    .accessibilityValue(section.fraction == nil ? "" : Strings.Memory.usage(chars: section.chars, limit: section.limit))
    .accessibilityIdentifier("hermie.memory.usage.\(section.target.rawValue)")
  }
}

/// The field under a file that adds an entry to it.
struct MemoryAddRow: View {
  let target: MemoryTarget
  let model: MemoryModel

  @State private var draft = ""

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField(Strings.Memory.Add.placeholder, text: $draft, axis: .vertical)
        .lineLimit(1...6)
        .accessibilityLabel(Strings.Memory.Add.label(target: target.fileName))
        .accessibilityIdentifier("hermie.memory.add.field.\(target.rawValue)")

      Button(Strings.Memory.Add.action) {
        let text = draft

        Task {
          if await model.add(target, content: text) {
            draft = ""
          }
        }
      }
      .disabled(model.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .accessibilityLabel(Strings.Memory.Add.label(target: target.fileName))
      .accessibilityIdentifier("hermie.memory.add.button.\(target.rawValue)")
    }
  }
}

/// Replace one entry's text: the text as it is, edited, and put back or left as it was.
struct MemoryEntryEditor: View {
  let model: MemoryModel
  let entry: MemoryEntry

  @Environment(\.dismiss) private var dismiss
  @State private var draft: String

  init(model: MemoryModel, entry: MemoryEntry) {
    self.model = model
    self.entry = entry
    _draft = State(initialValue: entry.text)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextEditor(text: $draft)
            .frame(minHeight: 160)
            .accessibilityLabel(Strings.Memory.Edit.label(index: entry.index))
            .accessibilityIdentifier("hermie.memory.edit.field")
        } header: {
          SettingsNote(entry.target.fileName)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(Strings.Memory.Edit.label(index: entry.index))
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.Memory.Edit.cancel) { dismiss() }
            .accessibilityIdentifier("hermie.memory.edit.cancel")
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.Memory.Edit.save) {
            let text = draft

            Task {
              if await model.replace(entry, with: text) {
                dismiss()
              }
            }
          }
          .disabled(model.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines) == entry.text
            || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("hermie.memory.edit.save")
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 440, minHeight: 300)
    #endif
  }
}

/// The raw side: every backend the gateway names, and each document as it is stored.
struct MemoryRawTab: View {
  let model: MemoryModel

  var body: some View {
    switch model.raw {
    case .idle, .loading:
      Section { CapabilityLoadingRow(text: Strings.Memory.Raw.loading) }
    case .missing:
      Section {
        CapabilityStatusRow(text: Strings.Memory.Raw.missing, symbol: "puzzlepiece.extension")
      } footer: {
        SettingsNote(Strings.Memory.Raw.missingHint + " " + Strings.Memory.Raw.missingCommand)
      }
    case .failed(let words):
      Section {
        CapabilityFailureRow(text: Strings.Memory.failed(reason: words)) { Task { await model.loadRaw() } }
      }
    case .loaded(let raw):
      if raw.backends.isEmpty {
        Section { CapabilityStatusRow(text: Strings.Memory.Raw.none, symbol: "tray") }
      }

      ForEach(raw.backends) { backend in
        backendSection(backend)
      }

      Section {
      } footer: {
        SettingsNote(Strings.Memory.Raw.readOnly)
      }
    }
  }

  private func backendSection(_ backend: MemoryBackendRaw) -> some View {
    Section {
      if !backend.available {
        Text(Strings.Memory.Raw.unavailable)
          .foregroundStyle(Color.primary)
      } else if backend.documents.isEmpty {
        Text(verbatim: backend.note ?? Strings.Memory.Raw.notListable)
          .foregroundStyle(Color.primary)
          .fixedSize(horizontal: false, vertical: true)
      }

      ForEach(backend.documents) { document in
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text(verbatim: document.label)
              .font(.headline)
              .accessibilityAddTraits(.isHeader)
            Spacer()
            Text(Strings.Memory.Raw.chars(chars: document.chars))
              .font(.footnote)
              .foregroundStyle(Color.primary)
          }

          if document.content.isEmpty {
            Text(Strings.Memory.Raw.emptyDocument)
              .foregroundStyle(Color.primary)
          } else {
            Text(verbatim: document.content)
              .font(.callout.monospaced())
              .textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
          }

          if document.truncated {
            Text(Strings.Memory.Raw.truncated)
              .font(.footnote)
              .foregroundStyle(Color.primary)
          }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hermie.memory.raw.\(backend.name).\(document.id)")
      }
    } header: {
      SettingsNote(backend.label)
    }
  }
}
