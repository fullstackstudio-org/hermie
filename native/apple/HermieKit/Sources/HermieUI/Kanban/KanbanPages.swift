import HermieCore
import SwiftUI

/**
 Settings → Boards: the Kanban boards the gateway keeps, and the work the bots pick up from them
 (`KanbanScreen` in the Expo app).

 The first page lists the boards; a board is its columns side by side, each with its cards, in the order
 the plugin gives them (a card's column IS its status, and cards are ordered by priority and age, so
 there is no order to drag within a column). A card moves from its menu ("Move to…"), to any column but
 the three the dispatcher owns; a refused move says why in the plugin's own sentence, naming the parents
 that are in the way. A card opens in a sheet to edit, comment on and archive (archiving keeps the card
 and its history; it is not a delete), and a new card is made from the toolbar.

 Kanban is a plugin: a gateway without it gets one explanation instead of a page. Every text here is the
 gateway's or a bot's: plain text, never Markdown.
 */
struct KanbanSettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.kanban.page") { session in
      KanbanBoardsPage(session: session)
    }
  }
}

struct KanbanBoardsPage: View {
  let session: GatewaySession

  @State private var model: KanbanBoardsModel?

  init(session: GatewaySession) {
    self.session = session
    _model = State(initialValue: session.kanbanBoards())
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
    .navigationTitle(Strings.Kanban.title)
    .accessibilityIdentifier("hermie.kanban.page")
  }

  private func content(_ model: KanbanBoardsModel) -> some View {
    Form {
      CapabilityNoticeSection(text: model.notice.map { Strings.Kanban.failed(reason: $0) }, dismiss: model.dismissNotice)

      switch model.phase {
      case .loading:
        Section { CapabilityLoadingRow(text: Strings.Kanban.loading) }
      case .failed(let words):
        Section { CapabilityFailureRow(text: Strings.Kanban.failed(reason: words)) { Task { await model.load() } } }
      case .missing:
        Section {
          CapabilityStatusRow(text: Strings.Kanban.absent, symbol: "puzzlepiece.extension", identifier: "hermie.kanban.absent")
        } footer: {
          SettingsNote(Strings.Kanban.absentHint + " " + Strings.Kanban.absentCommand)
        }
      case .ready:
        Section {
          if model.boards.isEmpty {
            Text(Strings.Kanban.empty)
              .foregroundStyle(Color.primary)
              .accessibilityIdentifier("hermie.kanban.empty")
          }

          ForEach(model.boards) { board in
            NavigationLink {
              KanbanBoardPage(session: session, board: board)
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: board.name)
                Text(Strings.Kanban.boardCards(count: board.total))
                  .font(.footnote)
                  .foregroundStyle(Color.primary)
                if !board.description.isEmpty {
                  Text(verbatim: board.description)
                    .font(.footnote)
                    .foregroundStyle(Color.primary)
                }
              }
              .accessibilityElement(children: .combine)
            }
            .accessibilityIdentifier("hermie.kanban.board.\(board.slug)")
          }
        } footer: {
          SettingsNote(model.boards.isEmpty ? Strings.Kanban.emptyHint : Strings.Kanban.subtitle)
        }
      }
    }
    .formStyle(.grouped)
    .task(id: ObjectIdentifier(model)) { await model.load() }
    .refreshable { await model.load() }
  }
}

/// One board: its columns side by side.
struct KanbanBoardPage: View {
  let session: GatewaySession
  let board: KanbanBoard

  @State private var model: KanbanBoardModel?
  @State private var creating = false
  @State private var opened: KanbanCard?
  @State private var archiving: KanbanCard?

  init(session: GatewaySession, board: KanbanBoard) {
    self.session = session
    self.board = board
    _model = State(initialValue: session.kanbanBoard(board.slug))
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
    .navigationTitle(board.name)
    .accessibilityIdentifier("hermie.kanban.board")
  }

  private func content(_ model: KanbanBoardModel) -> some View {
    VStack(spacing: 0) {
      if let notice = KanbanText.notice(model.notice) {
        KanbanNotice(text: notice, dismiss: model.dismissNotice)
      }

      switch model.phase {
      case .loading:
        CapabilityLoadingRow(text: Strings.Kanban.Board.loading)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      case .failed(let words):
        EmptyState(
          board.name, systemImage: "exclamationmark.triangle",
          message: Text(verbatim: Strings.Kanban.failed(reason: words))
        ) {
          Button(Strings.App.Common.retry) { Task { await model.load() } }
            .buttonStyle(.bordered)
        }
      case .notFound:
        EmptyState(board.name, systemImage: "tray", message: Text(NativeStrings.KanbanPage.boardGone))
      case .ready:
        board(model)
      }
    }
    .task(id: ObjectIdentifier(model)) { await model.load() }
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button(model.includeArchived ? Strings.Kanban.Board.hideArchived : Strings.Kanban.Board.showArchived,
          systemImage: model.includeArchived ? "archivebox.fill" : "archivebox"
        ) {
          Task { await model.setIncludeArchived(!model.includeArchived) }
        }
        .accessibilityIdentifier("hermie.kanban.archived")

        Button(Strings.Kanban.Board.newCard, systemImage: "plus") { creating = true }
          .disabled(model.phase != .ready)
          .accessibilityIdentifier("hermie.kanban.new")
      }
    }
    .sheet(isPresented: $creating) {
      KanbanCreateSheet(model: model)
    }
    .sheet(item: $opened) { card in
      KanbanCardSheet(model: model, cardID: card.id)
    }
    .confirmationDialog(
      Strings.Kanban.Card.archive, isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }),
      titleVisibility: .visible, presenting: archiving
    ) { card in
      Button(Strings.Kanban.Card.archive, role: .destructive) {
        Task { await model.archive(card.id) }
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { _ in
      Text(Strings.Kanban.Card.archiveHint)
    }
  }

  private func board(_ model: KanbanBoardModel) -> some View {
    VStack(spacing: 0) {
      GeometryReader { proxy in
        ScrollView(.horizontal) {
          HStack(alignment: .top, spacing: 12) {
            ForEach(model.lanes) { lane in
              KanbanLaneView(lane: lane, model: model, open: { opened = $0 }, archive: { archiving = $0 })
                .frame(width: 280, height: max(proxy.size.height - 16, 120))
            }
          }
          .padding(8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .refreshable { await model.load() }
      }

      if model.view.isEmpty {
        Text(Strings.Kanban.Board.empty)
          .font(.footnote)
          .foregroundStyle(Color.primary)
          .padding(.horizontal, 16)
          .padding(.top, 4)
      }

      Text(Strings.Kanban.locked + " " + Strings.Kanban.noOrder)
        .font(.footnote)
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// One column: its name and count, and its cards, each with the menu that moves it.
struct KanbanLaneView: View {
  let lane: KanbanLane
  let model: KanbanBoardModel
  let open: (KanbanCard) -> Void
  let archive: (KanbanCard) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(verbatim: KanbanText.column(lane.name))
          .font(.headline)
          .accessibilityAddTraits(.isHeader)
        Text(verbatim: "\(lane.cards.count)")
          .font(.subheadline)
          .foregroundStyle(Color.primary)
        if !lane.droppable {
          Image(systemName: "lock")
            .font(.footnote)
            .foregroundStyle(Color.primary)
            .accessibilityHidden(true)
        }
        Spacer()
      }
      .accessibilityElement(children: .combine)

      ScrollView(.vertical) {
        LazyVStack(spacing: 8) {
          if lane.cards.isEmpty {
            Text(Strings.Kanban.Board.columnEmpty)
              .font(.footnote)
              .foregroundStyle(Color.primary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
          }

          ForEach(lane.cards) { card in
            KanbanCardView(card: card, model: model, open: open, archive: archive)
          }
        }
      }
      .scrollBounceBehavior(.basedOnSize)
    }
    .padding(10)
    .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(KanbanText.column(lane.name))
    .accessibilityIdentifier("hermie.kanban.lane.\(lane.name)")
  }
}

/// One card in a column.
struct KanbanCardView: View {
  let card: KanbanCard
  let model: KanbanBoardModel
  let open: (KanbanCard) -> Void
  let archive: (KanbanCard) -> Void

  var body: some View {
    let busy = model.busy.contains(card.id)
    let targets = model.targets(for: card)

    Button {
      open(card)
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Text(verbatim: card.title)
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading)
          .multilineTextAlignment(.leading)

        HStack(spacing: 8) {
          if let assignee = card.assignee {
            Label(assignee, systemImage: "person")
              .labelStyle(.titleAndIcon)
          }

          if card.priority != 0 {
            Label("\(card.priority)", systemImage: "flag")
          }

          if card.commentCount > 0 {
            Label("\(card.commentCount)", systemImage: "bubble.left")
          }
        }
        .font(.footnote)
        .foregroundStyle(Color.primary)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background, in: .rect(cornerRadius: 10))
      .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(.separator) }
      .overlay(alignment: .topTrailing) {
        if busy {
          ProgressView()
            .controlSize(.small)
            .padding(8)
        }
      }
      .contentShape(.rect(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .contextMenu { menu(card, targets: targets) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(card.title)
    .accessibilityValue(KanbanText.spoken(card))
    .accessibilityHint(Strings.Kanban.dragLabel)
    .accessibilityAddTraits(.isButton)
    .accessibilityActions {
      ForEach(targets, id: \.self) { column in
        Button("\(Strings.Kanban.move) \(KanbanText.column(column))") {
          Task { await model.move(card, to: column) }
        }
      }
    }
    .accessibilityIdentifier("hermie.kanban.card.\(card.id)")
  }

  @ViewBuilder private func menu(_ card: KanbanCard, targets: [String]) -> some View {
    Menu(Strings.Kanban.move, systemImage: "arrow.right") {
      ForEach(targets, id: \.self) { column in
        Button(KanbanText.column(column)) {
          Task { await model.move(card, to: column) }
        }
      }
    }

    Button(Strings.Kanban.Card.archive, systemImage: "archivebox") {
      archive(card)
    }
  }
}

/// The notice at the top of a board: what the last write said.
struct KanbanNotice: View {
  let text: String
  let dismiss: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Label {
        Text(verbatim: text)
          .foregroundStyle(Color.primary)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "info.circle")
          .foregroundStyle(Color.primary)
          .accessibilityHidden(true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      Button(Strings.App.Common.dismiss, systemImage: "xmark", action: dismiss)
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
    .background(.quaternary.opacity(0.5))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.kanban.notice")
  }
}

/// Make a card: a title, notes and the column it should land in.
struct KanbanCreateSheet: View {
  let model: KanbanBoardModel

  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var notes = ""
  @State private var column = "ready"
  @State private var triedWithoutTitle = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(Strings.Kanban.Create.titleField, text: $title, prompt: Text(Strings.Kanban.Create.titlePlaceholder))
            .accessibilityIdentifier("hermie.kanban.create.title")

          if triedWithoutTitle, title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(Strings.Kanban.Create.needsTitle)
              .font(.footnote)
              .foregroundStyle(Color.primary)
          }

          TextField(Strings.Kanban.Create.bodyField, text: $notes, axis: .vertical)
            .lineLimit(2...6)
            .accessibilityIdentifier("hermie.kanban.create.notes")
        }

        Section {
          Picker(Strings.Kanban.Create.column, selection: $column) {
            ForEach(columns, id: \.self) { name in
              Text(verbatim: KanbanText.column(name)).tag(name)
            }
          }
          .accessibilityIdentifier("hermie.kanban.create.column")
        }
      }
      .formStyle(.grouped)
      .navigationTitle(Strings.Kanban.Create.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) { dismiss() }
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(model.creating ? Strings.Kanban.Create.submitting : Strings.Kanban.Create.submit) {
            guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
              triedWithoutTitle = true

              return
            }

            Task {
              if await model.create(KanbanCardInput(title: title, body: notes, column: column)) {
                dismiss()
              }
            }
          }
          .disabled(model.creating)
          .accessibilityIdentifier("hermie.kanban.create.submit")
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 360)
    #endif
  }

  /// The columns a new card may land in: not the dispatcher's, and not the archive.
  private var columns: [String] {
    let named = model.lanes.map(\.name).filter { KanbanColumns.canDrop(into: $0) && $0 != "archived" }

    return named.isEmpty ? ["ready", "triage"] : named
  }
}

/// One card, opened: its fields to edit, a menu to move it, its comments, and archiving it.
struct KanbanCardSheet: View {
  let model: KanbanBoardModel
  let cardID: String

  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var notes = ""
  @State private var assignee = ""
  @State private var priority = 0
  @State private var comment = ""
  @State private var archiving = false
  @State private var seeded = false

  var body: some View {
    NavigationStack {
      Form {
        if let notice = KanbanText.notice(model.notice) {
          Section { CapabilityStatusRow(text: notice, symbol: "info.circle") }
        }

        switch model.details[cardID] {
        case nil, .loading:
          Section { CapabilityLoadingRow(text: Strings.Kanban.Board.loading) }
        case .failed(let words):
          Section {
            CapabilityFailureRow(text: Strings.Kanban.failed(reason: words)) { Task { await model.loadDetail(cardID) } }
          }
        case .loaded(let detail):
          fields(detail.card)
          comments(detail.comments)
          archive
        }
      }
      .formStyle(.grouped)
      .navigationTitle(model.view.card(cardID)?.title ?? "")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.done) { dismiss() }
            .accessibilityIdentifier("hermie.kanban.card.done")
        }
      }
      .task { await model.loadDetail(cardID) }
      .onChange(of: model.details[cardID]) { _, now in
        if !seeded, case .loaded(let detail)? = now {
          seed(detail.card)
        }
      }
      .confirmationDialog(
        Strings.Kanban.Card.archive, isPresented: $archiving, titleVisibility: .visible
      ) {
        Button(Strings.Kanban.Card.archive, role: .destructive) {
          Task {
            if await model.archive(cardID) {
              dismiss()
            }
          }
        }
        Button(Strings.App.Common.cancel, role: .cancel) {}
      } message: {
        Text(Strings.Kanban.Card.archiveHint)
      }
    }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 520)
    #endif
    .accessibilityIdentifier("hermie.kanban.card.sheet")
  }

  private func seed(_ card: KanbanCard) {
    title = card.title
    notes = card.body
    assignee = card.assignee ?? ""
    priority = card.priority
    seeded = true
  }

  private func fields(_ card: KanbanCard) -> some View {
    let dirty =
      title != card.title || notes != card.body || assignee != (card.assignee ?? "") || priority != card.priority

    return Group {
      Section {
        TextField(Strings.Kanban.Card.title, text: $title)
          .accessibilityIdentifier("hermie.kanban.card.title")

        TextField(Strings.Kanban.Card.body, text: $notes, axis: .vertical)
          .lineLimit(2...8)
          .accessibilityIdentifier("hermie.kanban.card.notes")

        Picker(Strings.Kanban.Card.assignee, selection: $assignee) {
          Text(NativeStrings.KanbanPage.noAssignee).tag("")
          ForEach(assignees(including: card.assignee), id: \.self) { name in
            Text(verbatim: name).tag(name)
          }
        }

        Stepper(value: $priority, in: -100...100) {
          Text("\(Strings.Kanban.Card.priority): \(priority)")
        }
        .accessibilityIdentifier("hermie.kanban.card.priority")

        LabeledContent(Strings.Kanban.Card.column) {
          Menu(KanbanText.column(card.status)) {
            ForEach(model.targets(for: card), id: \.self) { column in
              Button(KanbanText.column(column)) {
                Task {
                  if await model.move(card, to: column) {
                    await model.loadDetail(cardID)
                  }
                }
              }
            }
          }
          .disabled(model.busy.contains(cardID))
        }

        if let created = card.createdAt {
          LabeledContent(Strings.Kanban.Card.created) {
            Text(created, format: .dateTime.day().month().year().hour().minute())
          }
        }

        Button(model.busy.contains(cardID) ? Strings.Kanban.Card.saving : Strings.Kanban.Card.save) {
          let edit = KanbanCardEdit(
            title: title == card.title ? nil : title,
            body: notes == card.body ? nil : notes,
            assignee: assignee == (card.assignee ?? "") || assignee.isEmpty ? nil : assignee,
            priority: priority == card.priority ? nil : priority)

          Task { await model.edit(cardID, edit) }
        }
        .disabled(!dirty || model.busy.contains(cardID) || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("hermie.kanban.card.save")
      }

      if let summary = card.latestSummary {
        Section {
          Text(verbatim: summary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        } header: {
          SettingsNote(Strings.Kanban.Card.summary)
        }
      }
    }
  }

  private func assignees(including current: String?) -> [String] {
    var names = model.view.assignees

    if let current, !names.contains(current) {
      names.append(current)
    }

    return names
  }

  private func comments(_ comments: [KanbanComment]) -> some View {
    Section {
      if comments.isEmpty {
        Text(Strings.Kanban.Comments.none)
          .foregroundStyle(Color.primary)
      }

      ForEach(comments) { entry in
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: entry.author)
            .font(.footnote.weight(.semibold))
          Text(verbatim: entry.body)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
      }

      HStack(alignment: .bottom, spacing: 8) {
        TextField(Strings.Kanban.Comments.placeholder, text: $comment, axis: .vertical)
          .lineLimit(1...5)
          .accessibilityIdentifier("hermie.kanban.comment.field")

        Button(model.busy.contains(cardID) ? Strings.Kanban.Comments.adding : Strings.Kanban.Comments.add) {
          let text = comment

          Task {
            if await model.comment(cardID, text) {
              comment = ""
            }
          }
        }
        .disabled(model.busy.contains(cardID) || comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("hermie.kanban.comment.add")
      }
    } header: {
      SettingsNote(Strings.Kanban.Comments.header)
    }
  }

  private var archive: some View {
    Section {
      Button(Strings.Kanban.Card.archive, systemImage: "archivebox", role: .destructive) { archiving = true }
        .disabled(model.busy.contains(cardID))
        .accessibilityIdentifier("hermie.kanban.card.archive")
    } footer: {
      SettingsNote(Strings.Kanban.Card.archiveHint)
    }
  }
}

/// The words of the Boards pages, from the model's cases.
enum KanbanText {
  /// A column's name as the person reads it, and the plugin's own word for one this build does not know.
  static func column(_ name: String) -> String {
    Strings.Kanban.Columns[name] ?? name
  }

  static func notice(_ notice: KanbanBoardModel.Notice?) -> String? {
    switch notice {
    case .moved(let to): Strings.Kanban.moved(column: column(to))
    case .movedElsewhere(let asked, let got): Strings.Kanban.movedElsewhere(asked: column(asked), got: column(got))
    case .lockedTarget(let target): Strings.Kanban.lockedTarget(column: column(target))
    case .words(let words): Strings.Kanban.moveRefused(reason: words)
    case .archived: Strings.Kanban.Card.archived
    case nil: nil
    }
  }

  /// What VoiceOver says of a card after its title: where it is and what it carries.
  static func spoken(_ card: KanbanCard) -> String {
    var parts = [column(card.status)]

    if let assignee = card.assignee {
      parts.append("\(Strings.Kanban.Card.assignee): \(assignee)")
    }

    if card.priority != 0 {
      parts.append("\(Strings.Kanban.Card.priority): \(card.priority)")
    }

    if card.commentCount > 0 {
      parts.append("\(Strings.Kanban.Comments.header.capitalized): \(card.commentCount)")
    }

    return parts.joined(separator: ", ")
  }
}
