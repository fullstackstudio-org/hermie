import HermieMarkdown
import HermieTranscript
import SwiftUI

/// Bots talking to each other, in either direction: an aside on the leading
/// side, closed by default, with the same silhouette as a reply's thought.
///
/// `collapsed` is the aside; `chip` (bot-to-bot hidden) is one line that opens
/// the other bot's chat. Never `full`: the reader opens an aside by tapping it,
/// and the tap is remembered.
struct BotDmAsideView: View {
  let item: TranscriptItem
  let presentation: Presentation

  @Environment(\.transcriptExpansion) private var expansion
  @Environment(\.transcriptItemActions) private var actions

  private var model: BotDmModel? { BotDmModel(item) }

  var body: some View {
    if let model {
      switch presentation {
      case .hiddenPlaceholder:
        EmptyView()
      case .chip:
        ItemChip(text: model.chipText, systemImage: model.outbound ? "arrow.up.right" : "arrow.down.left") {
          actions.openBotChat(model.handle)
        }
        .accessibilityHint(model.outbound ? Strings.Chat.BotDm.openTarget(target: model.handle) : Strings.Chat.BotDm.openSender(name: model.handle))
      case .collapsed, .full:
        BotDmAside(model: model, box: expansion.box("dm:\(item.id)", default: false))
      }
    }
  }
}

/// What both directions have in common, read once.
struct BotDmModel: Equatable {
  var outbound: Bool
  var handle: String
  var displayName: String
  var text: String
  var ts: Double?
  var dispatch: BotDmDispatch?
  var reply: BotDmReply?
  var answersOurDispatch: Bool

  init?(_ item: TranscriptItem) {
    switch item {
    case .botDmOut(let out):
      outbound = true
      handle = out.targetHandle
      displayName = out.target
      text = out.message
      ts = out.ts
      dispatch = out.dispatch
      reply = out.reply
      answersOurDispatch = false
    case .botDmIn(let incoming):
      outbound = false
      handle = incoming.senderHandle ?? incoming.senderName
      displayName = incoming.senderName
      text = incoming.text
      ts = incoming.ts
      dispatch = nil
      reply = nil
      answersOurDispatch = incoming.answersOurDispatch == true
    default:
      return nil
    }
  }

  var chipText: String {
    outbound ? Strings.Chat.BotDm.chip(target: displayName) : Strings.Chat.BotDm.inChip(name: displayName)
  }

  var header: String {
    outbound ? Strings.Chat.BotDm.asideTo(handle: handle) : Strings.Chat.BotDm.asideFrom(handle: handle)
  }

  var failed: Bool { dispatch?.status == .failed }
  var replied: Bool { reply.map { $0.error == nil } ?? false }

  /// The marker an outbound aside carries.
  var marker: String? {
    guard outbound else { return answersOurDispatch ? Strings.Chat.BotDm.answered : nil }
    if failed { return Strings.Chat.BotDm.Marker.failed }
    if replied { return Strings.Chat.BotDm.Marker.replied }
    return Strings.Chat.BotDm.Marker.waiting
  }

  var dispatchStatus: String? {
    guard let dispatch else { return nil }
    switch dispatch.status {
    case .sending: return Strings.Chat.BotDm.sending
    case .queued: return Strings.Chat.BotDm.queued
    case .failed: return Strings.Chat.BotDm.failed
    case .ambiguous: return Strings.Chat.BotDm.ambiguous
    case .unknown, .other: return Strings.Chat.BotDm.unknown
    }
  }
}

struct BotDmAside: View {
  let model: BotDmModel
  @Bindable var box: TranscriptExpansion.Box

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.transcriptItemActions) private var actions

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      DisclosureHeader(box: box) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Image(systemName: model.outbound ? "arrow.up.right" : "arrow.down.left")
              .imageScale(.small)
              .accessibilityHidden(true)
            Text(model.header)
              .font(.footnote.weight(.semibold))
            if let clock = ItemFormat.clock(model.ts) {
              Text(clock).font(.caption)
            }
            if let marker = model.marker {
              Text(marker)
                .font(.caption)
                .foregroundStyle(model.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
          }
          if !box.isExpanded {
            Text(ItemFormat.preview(model.text, limit: 60))
              .font(.footnote)
              .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
          }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      if box.isExpanded {
        expanded
      }
    }
    .padding(.leading, 10)
    .overlay(alignment: .leading) {
      Rectangle().fill(.quaternary).frame(width: 2)
    }
    .padding(.trailing, 48)
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      Button(Strings.Chat.Menu.copyText) { actions.copy(model.text) }
      Button(Strings.Chat.BotDm.openChat(handle: model.handle)) { actions.openBotChat(model.handle) }
    }
  }

  @ViewBuilder private var expanded: some View {
    MarkdownView(MarkdownDocument(model.text))
      .markdownChartWords()
      .font(.callout)
    if let status = model.dispatchStatus {
      Text(status).font(.caption).foregroundStyle(model.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
    }
    if let error = model.dispatch?.error {
      Text(error).font(.caption).foregroundStyle(.red)
    }
    if let reply = model.reply {
      VStack(alignment: .leading, spacing: 2) {
        Text(Strings.Chat.BotDm.reply)
          .font(.caption.weight(.semibold))
          .textCase(.uppercase)
          .foregroundStyle(.secondary)
        Text(reply.error ?? reply.text)
          .font(.callout)
          .foregroundStyle(reply.error == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.red))
          .textSelection(.enabled)
      }
    }
    Button(Strings.Chat.BotDm.openChat(handle: model.handle)) { actions.openBotChat(model.handle) }
      .font(.footnote)
      .buttonStyle(.borderless)
  }
}

/// A run of more than three bot-to-bot rows, as one line that opens in place
/// (`BotDmRollup`).
struct BotDmRollupView: View {
  let id: String
  let members: [VisibleItem]

  @Environment(\.transcriptExpansion) private var expansion

  var body: some View {
    let box = expansion.box(id, default: false)
    VStack(alignment: .leading, spacing: 8) {
      DisclosureHeader(box: box) {
        Label(box.isExpanded ? Strings.Chat.Fold.less : label, systemImage: "bubble.left.and.bubble.right")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if box.isExpanded {
        ForEach(members, id: \.item.id) { member in
          BotDmAsideView(item: member.item, presentation: member.presentation)
        }
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var label: String {
    let models = members.compactMap { BotDmModel($0.item) }
    let handles = Set(models.map(\.handle))
    let replies = models.filter { $0.outbound && $0.replied }.count
    if handles.count == 1, let handle = handles.first {
      return Strings.Chat.BotDm.rollup(count: models.count, handle: handle, replies: replies)
    }
    return Strings.Chat.BotDm.rollupMixed(count: models.count, replies: replies)
  }
}
