import HermieCore
import SwiftUI
import UniformTypeIdentifiers

/**
 Settings, Decision log: what the person approved, denied, confirmed or entered, newest first and by day,
 narrowed by bot and kind and by a search, and exportable as CSV or JSON.

 Everything comes from this device (`DecisionLog`); no gateway is asked, so the page works offline and
 keeps working for a gateway that is signed out of (whose entries are gone, see `DecisionLog`). An entry says
 what kind of request it was, what was decided, how, for which bot on which gateway and when, and for an
 approval the first line of its command: never a typed secret, a device payload or the text of a form.
 */
struct DecisionLogSettingsEntry: View {
  @Environment(AppLaunch.self) private var launch

  var body: some View {
    DecisionLogScreen(log: launch.decisions, scope: .everything)
  }
}

/// The log over a model: the page of Settings, and one bot's page from its settings.
struct DecisionLogScreen: View {
  let log: DecisionLog

  @State private var model: DecisionLogModel
  @State private var confirmingClear = false
  #if os(macOS)
    @State private var exportDocument: DecisionExportDocument?
  #endif

  init(log: DecisionLog, scope: DecisionLogModel.Scope) {
    self.log = log

    let model = DecisionLogModel(log: log, scope: scope)

    model.searchText = { entry in
      [
        NativeStrings.Decisions.kind(entry.kind), NativeStrings.Decisions.outcome(entry.outcome),
        NativeStrings.Decisions.method(entry.method), NativeStrings.Decisions.summary(of: entry) ?? ""
      ].joined(separator: " ")
    }
    _model = State(initialValue: model)
  }

  var body: some View {
    List {
      if model.loaded, !model.entries.isEmpty {
        filterSection
      }

      content

      if model.loaded, !model.entries.isEmpty {
        Section {
        } footer: {
          Text(NativeStrings.Decisions.note)
        }
      }
    }
    .searchable(text: $model.query, prompt: NativeStrings.Decisions.searchPrompt)
    .toolbar { toolbar }
    .task(id: log.revision) { await model.load() }
    .confirmationDialog(NativeStrings.Decisions.clearTitle, isPresented: $confirmingClear, titleVisibility: .visible) {
      Button(NativeStrings.Decisions.clearConfirm, role: .destructive) {
        Task { await log.clear() }
      }
      .accessibilityIdentifier("hermie.decisions.clear.confirm")
    } message: {
      Text(NativeStrings.Decisions.clearMessage)
    }
    #if os(macOS)
      .fileExporter(
        isPresented: Binding(get: { exportDocument != nil }, set: { if !$0 { exportDocument = nil } }),
        document: exportDocument,
        contentType: exportDocument?.format.contentType ?? .commaSeparatedText,
        defaultFilename: exportDocument.map { DecisionExport.fileName($0.format) } ?? "decisions"
      ) { _ in
        exportDocument = nil
      }
    #endif
    .navigationTitle(NativeStrings.Decisions.title)
    .accessibilityIdentifier("hermie.decisions.page")
  }

  // MARK: Content

  @ViewBuilder private var content: some View {
    if !model.loaded {
      Section {
        ProgressView()
          .frame(maxWidth: .infinity)
      }
    } else if model.entries.isEmpty {
      Section {
        Text(NativeStrings.Decisions.empty)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.decisions.empty")
      } footer: {
        Text(NativeStrings.Decisions.note)
      }
    } else if model.days.isEmpty {
      Section {
        Text(NativeStrings.Decisions.noMatch)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.decisions.noMatch")
      }
    } else {
      ForEach(model.days) { day in
        Section {
          ForEach(day.entries) { entry in
            DecisionRow(entry: entry, showsBot: model.scope.bot == nil)
          }
        } header: {
          Text(day.day, format: .dateTime.weekday(.wide).day().month(.wide).year())
        }
      }
    }
  }

  private var filterSection: some View {
    Section {
      if model.scope.bot == nil, model.bots.count > 1 {
        Picker(NativeStrings.Decisions.filterBot, selection: $model.botFilter) {
          Text(NativeStrings.Decisions.allBots).tag(String?.none)

          ForEach(model.bots, id: \.self) { bot in
            Text(verbatim: bot).tag(String?.some(bot))
          }
        }
        .accessibilityIdentifier("hermie.decisions.filter.bot")
      }

      Picker(NativeStrings.Decisions.filterKind, selection: $model.kindFilter) {
        Text(NativeStrings.Decisions.allKinds).tag(DecisionKind?.none)

        ForEach(model.kinds) { kind in
          Text(NativeStrings.Decisions.kind(kind)).tag(DecisionKind?.some(kind))
        }
      }
      .accessibilityIdentifier("hermie.decisions.filter.kind")
    }
  }

  // MARK: Toolbar

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .primaryAction) {
      Menu {
        exportItems

        Divider()

        Button(NativeStrings.Decisions.clear, role: .destructive) {
          confirmingClear = true
        }
        .accessibilityIdentifier("hermie.decisions.clear")
      } label: {
        Label(NativeStrings.Decisions.export, systemImage: "ellipsis.circle")
      }
      .disabled(!model.loaded || model.entries.isEmpty)
      .accessibilityIdentifier("hermie.decisions.menu")
    }
  }

  /// Export what the filters leave, through the share sheet on iPhone and iPad and the save panel on the Mac.
  @ViewBuilder private var exportItems: some View {
    ForEach(DecisionExportFormat.allCases) { format in
      #if os(macOS)
        Button(NativeStrings.Decisions.exportAs(format)) {
          exportDocument = DecisionExportDocument(entries: model.filtered, format: format)
        }
        .accessibilityIdentifier("hermie.decisions.export.\(format.rawValue)")
      #else
        let file = DecisionExportFile(entries: model.filtered, format: format)

        ShareLink(item: file, preview: SharePreview(file.fileName)) {
          Label(NativeStrings.Decisions.exportAs(format), systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("hermie.decisions.export.\(format.rawValue)")
      #endif
    }
  }
}

/// One decision: what was decided and about what kind of request, what it was about, and for whom, how and when.
struct DecisionRow: View {
  let entry: DecisionEntry
  var showsBot = true

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: Self.symbol(entry.outcome))
        .foregroundStyle(Self.tint(entry.outcome))
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(NativeStrings.Decisions.outcome(entry.outcome))
            .font(.headline)

          Text(NativeStrings.Decisions.kind(entry.kind))
            .font(.subheadline)
            .foregroundStyle(.secondary)

          Spacer(minLength: 8)

          Text(entry.at, format: .dateTime.hour().minute())
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }

        if let summary = NativeStrings.Decisions.summary(of: entry) {
          Text(verbatim: summary)
            .font(.callout)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }

        Text(verbatim: Self.detail(entry, showsBot: showsBot))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.decisions.row")
  }

  /// "researcher · Home · Tap": the bot (unless the page is about one), the gateway and how it was decided.
  static func detail(_ entry: DecisionEntry, showsBot: Bool) -> String {
    var parts: [String] = []

    if showsBot, !entry.bot.isEmpty {
      parts.append(entry.bot)
    }

    if !entry.gateway.isEmpty {
      parts.append(entry.gateway)
    }

    parts.append(NativeStrings.Decisions.method(entry.method))

    return parts.joined(separator: " · ")
  }

  static func symbol(_ outcome: DecisionOutcome) -> String {
    switch outcome {
    case .denied, .declined: "xmark.circle.fill"
    case .skipped: "minus.circle.fill"
    default: "checkmark.circle.fill"
    }
  }

  static func tint(_ outcome: DecisionOutcome) -> Color {
    switch outcome {
    case .denied, .declined: .red
    case .skipped: .secondary
    default: .green
    }
  }
}

// MARK: Export

extension DecisionExportFormat {
  var contentType: UTType {
    switch self {
    case .csv: .commaSeparatedText
    case .json: .json
    }
  }
}

/// The log as the share sheet takes it: the file is made when it is sent, from the entries the filters left.
struct DecisionExportFile: Transferable, Sendable {
  let entries: [DecisionEntry]
  let format: DecisionExportFormat

  var fileName: String { DecisionExport.fileName(format) }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .commaSeparatedText) { file in
      DecisionExport.data(file.entries, as: .csv)
    }
    .exportingCondition { $0.format == .csv }
    .suggestedFileName("hermie-decisions.csv")

    DataRepresentation(exportedContentType: .json) { file in
      DecisionExport.data(file.entries, as: .json)
    }
    .exportingCondition { $0.format == .json }
    .suggestedFileName("hermie-decisions.json")
  }
}

/// The log as the Mac's save panel takes it.
struct DecisionExportDocument: FileDocument {
  static let readableContentTypes: [UTType] = [.commaSeparatedText, .json]

  let entries: [DecisionEntry]
  let format: DecisionExportFormat

  init(entries: [DecisionEntry], format: DecisionExportFormat) {
    self.entries = entries
    self.format = format
  }

  /// Nothing is opened in this app: the type exists to be saved.
  init(configuration: ReadConfiguration) throws {
    entries = []
    format = configuration.contentType == .json ? .json : .csv
  }

  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: DecisionExport.data(entries, as: format))
  }
}
