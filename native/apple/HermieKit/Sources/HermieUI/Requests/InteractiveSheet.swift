import HermieCore
import HermieProtocol
import SwiftUI

extension View {
  /// Answer the chat's interactive requests (`input.form`, `input.file`, `review.draft`, `review.diff`): the sheet
  /// for the oldest open one, raised as it arrives (never over the app lock, and never while
  /// `blocked`, which is another sheet of the chat being up), and the chat's notice when one
  /// ended without the person's answer or could not be shown. Putting the sheet away with Later,
  /// Esc or a swipe is never an answer: the request stays open in the transcript, whose card opens
  /// it again.
  public func interactiveRequests(_ model: InteractiveModel, blocked: Bool = false) -> some View {
    modifier(InteractiveSheetModifier(model: model, blocked: blocked))
  }
}

extension EnvironmentValues {
  /// The chat's interactive requests, read by the transcript's request card to open the sheet for
  /// a request that is still waiting. Nil outside a chat screen: the card then only reports.
  @Entry public var transcriptInteractive: InteractiveModel?
}

struct InteractiveSheetModifier: ViewModifier {
  let model: InteractiveModel
  let blocked: Bool

  @Environment(AppLaunch.self) private var launch: AppLaunch?

  private struct Presented: Identifiable {
    let id: String
  }

  /// What decides whether the next request comes up.
  private struct Raise: Equatable {
    let next: String?
    let locked: Bool
    let blocked: Bool
    /// An answer or an upload is on its way: the sheet does not step aside until it is done.
    let working: Bool
  }

  /// The app lock's plate is up, or its setting not read yet.
  private var locked: Bool {
    guard let lock = launch?.lock else {
      return false
    }

    return !lock.ready || lock.machine.locked
  }

  func body(content: Content) -> some View {
    content
      .environment(\.transcriptInteractive, model)
      .safeAreaInset(edge: .top, spacing: 0) {
        InteractiveNoticeView(model: model)
      }
      .chatSheet(item: presented) { _ in
        InteractiveSheetView(model: model)
          .presentationDetents([.large])
          // Opaque: what is asked is read against a plain background.
          .presentationBackground(.background)
          #if os(macOS)
            .frame(minWidth: 460, idealWidth: 520, minHeight: 420, idealHeight: 640)
          #endif
      }
      .onChange(of: Raise(next: model.nextToPresent, locked: locked, blocked: blocked, working: !model.canYield), initial: true) { _, raise in
        // An approval or a secure prompt is time-critical: the sheet steps aside for it (it comes back by
        // itself once the screen is free), and none comes up while one waits.
        if raise.blocked {
          model.yield()
        } else if !raise.locked, let next = raise.next {
          model.present(next)
        }
      }
      .onChange(of: model.presentedID == nil || model.presented != nil || model.presentedOutcome != nil) { _, showing in
        // The shown request ended with nothing to say (it was answered from this device): the
        // sheet goes.
        if !showing {
          model.dismiss()
        }
      }
      .onChange(of: model.lastAnswered) { _, answered in
        if answered != nil {
          AccessibilityNotification.Announcement(NativeStrings.Requests.answered).post()
        }
      }
      .onChange(of: model.presentedOutcome) { _, outcome in
        if let outcome {
          AccessibilityNotification.Announcement(InteractiveNoticeView.sheetText(outcome)).post()
        }
      }
  }

  private var presented: Binding<Presented?> {
    Binding(
      get: { locked ? nil : model.presentedID.map(Presented.init(id:)) },
      set: { value in
        guard value == nil, model.presentedID != nil else {
          return
        }

        // A swipe or Esc while the request is open is Later; once it ended, it is Close.
        if model.presented != nil {
          model.later()
        } else {
          model.dismiss()
        }
      }
    )
  }
}

/// The sheet for one request: the one for its method.
struct InteractiveSheetView: View {
  let model: InteractiveModel

  var body: some View {
    if let prompt = model.presentedPrompt {
      switch prompt.body {
      case .form(let params):
        FormSheetView(model: model, prompt: prompt, params: params)
          // A view of its own per request: what was typed never carries over to the next one.
          .id(prompt.id)
      case .file(let params):
        FileSheetView(model: model, prompt: prompt, params: params)
          .id(prompt.id)
      case .draft(let params):
        DraftSheetView(model: model, prompt: prompt, params: params)
          .id(prompt.id)
      case .diff(let diff):
        DiffSheetView(model: model, prompt: prompt, diff: diff)
          .id(prompt.id)
      case .location(let request):
        LocationSheetView(model: model, prompt: prompt, request: request)
          .id(prompt.id)
      case .contact(let request):
        ContactSheetView(model: model, prompt: prompt, request: request)
          .id(prompt.id)
      case .calendar(let request):
        CalendarSheetView(model: model, prompt: prompt, request: request)
          .id(prompt.id)
      }
    }
  }
}

// MARK: - The frame

/// The constant frame of every interactive sheet. Its chrome is the app's own, the same every time
/// and always in view: who asks (the bot, by the name this app knows it under), on which gateway,
/// and for what kind of thing, pinned at the top; the buttons pinned at the bottom. What the agent
/// says is shown between them as plain text (`Text(verbatim:)`: never Markdown, never a link),
/// marked as the agent's own words; only that and the fields scroll.
struct InteractiveSheetFrame<Content: View, Actions: View>: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let icon: String
  let title: String
  /// Whether the sheet may not be swiped away right now (an answer or an upload is on its way).
  var busy = false
  @ViewBuilder var content: Content
  @ViewBuilder var actions: Actions

  /// The most of a pinned area's text size: the chrome and the actions must leave room for the
  /// fields at the largest sizes. The scroll area follows the person's size in full.
  static var pinnedTextSize: DynamicTypeSize { .xxxLarge }

  @AccessibilityFocusState private var titleFocused: Bool
  @Environment(\.scenePhase) private var phase

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        Label {
          Text(verbatim: title)
        } icon: {
          Image(systemName: icon)
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
        .font(.title2.bold())
        .lineLimit(3)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .accessibilityFocused($titleFocused)
        .accessibilityIdentifier("interactive.title")

        Text(NativeStrings.SecureInput.gateway(model.gatewayName))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .accessibilityIdentifier("interactive.gateway")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 20)
      .padding(.top, 20)
      .padding(.bottom, 12)
      .dynamicTypeSize(...Self.pinnedTextSize)
      .clipped()

      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if model.presented != nil {
            if prompt.earlierAnswerLost {
              Label(NativeStrings.Interactive.earlierAnswerLost, systemImage: "exclamationmark.triangle")
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("interactive.earlierAnswerLost")
            }

            AgentWordsView(model: model, prompt: prompt)
            content
          } else {
            InteractiveOutcomeView(model: model)
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollDismissesKeyboard(.interactively)
      // The request's words are read sharp to the edge, never faded under the pinned chrome.
      .scrollEdgeEffectHidden(true, for: .vertical)

      Divider()

      VStack(alignment: .leading, spacing: 10) {
        if model.presented != nil {
          InteractiveStatusView(model: model)
          actions
        } else {
          Button {
            model.dismiss()
          } label: {
            Text(NativeStrings.Interactive.close)
              .font(.title3.weight(.semibold))
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .tint(.primary)
          .controlSize(.large)
          .keyboardShortcut(.cancelAction)
          .accessibilityIdentifier("interactive.close")
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
      .dynamicTypeSize(...Self.pinnedTextSize)
    }
    .background(.background)
    .interactiveDismissDisabled(busy)
    // Not in front: nothing of the request or the answer shows in the app switcher, behind another
    // window, or on a shared screen.
    .overlay {
      if phase != .active {
        PrivacyCoverView()
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("interactive.sheet")
    .task(id: prompt.id) {
      titleFocused = true
    }
  }
}

/// What the agent says, as plain text in a box marked as the agent's: its heading, what it asks and
/// why, and the detail in a monospaced block. Already cleaned and bounded by `InteractivePrompt`.
struct AgentWordsView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(NativeStrings.Interactive.says(model.botName))
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("interactive.says")
      Text(verbatim: prompt.title)
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("interactive.agentTitle")
      if !prompt.summary.isEmpty {
        Text(verbatim: prompt.summary)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("interactive.summary")
      }
      if let detail = prompt.detail {
        RequestTextBox(text: detail, identifier: "interactive.detail", monospaced: true)
      }
      if let name = prompt.actingUser {
        Text(NativeStrings.Interactive.onBehalfOf(name))
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background.secondary, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
  }
}

/// Under the fields: the answer on its way, the answer that did not go out, the gateway's refusal
/// that names no field, or the time left.
struct InteractiveStatusView: View {
  let model: InteractiveModel

  var body: some View {
    if model.isSending {
      HStack(spacing: 6) {
        ProgressView()
          .controlSize(.small)
        Text(NativeStrings.Requests.sending)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("interactive.sending")
    } else if model.hasFailed {
      Label(NativeStrings.Requests.failed(nil), systemImage: "exclamationmark.triangle")
        .font(.caption)
        .foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("interactive.failed")
    } else {
      if let reason = model.refusal, FormRefusal(reason: reason) == nil {
        Label(NativeStrings.Interactive.refusal(reason), systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("interactive.refused")
      }

      if model.secondsLeft != nil {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
          let left = model.secondsLeft ?? 0
          Label(NativeStrings.Requests.closesIn(RequestCountdownView.clock(left)), systemImage: "timer")
            .font(.caption.monospacedDigit())
            .foregroundStyle(left <= 10 ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
            .accessibilityIdentifier("interactive.countdown")
        }
      }
    }
  }
}

/// How the shown request ended, when it ended without the person's answer.
struct InteractiveOutcomeView: View {
  let model: InteractiveModel

  var body: some View {
    if let outcome = model.presentedOutcome {
      Label(InteractiveNoticeView.sheetText(outcome), systemImage: InteractiveNoticeView.icon(outcome))
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("interactive.outcome")
    }
  }
}

/// Buttons side by side when they fit, stacked when they do not, so the pinned bottom stays short.
struct InteractiveButtonRow<Buttons: View>: View {
  @ViewBuilder var buttons: Buttons

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 10) { buttons }
      VStack(spacing: 10) { buttons }
    }
  }
}

/// Later: put the sheet away. Never an answer.
struct LaterButton: View {
  let model: InteractiveModel

  var body: some View {
    Button {
      model.later()
    } label: {
      Text(NativeStrings.Interactive.later)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .tint(.primary)
    .controlSize(.large)
    .keyboardShortcut(.cancelAction)
    .disabled(model.isSending)
    .accessibilityIdentifier("interactive.later")
  }
}

/// Skip, for a request that offers it. Answers `{status: skipped}`.
struct SkipButton: View {
  let model: InteractiveModel
  let armed: Bool
  var disabled = false
  var onSkipped: () -> Void = {}

  var body: some View {
    Button {
      guard armed else {
        return
      }

      Task {
        if await model.skip() {
          onSkipped()
        }
      }
    } label: {
      Text(NativeStrings.Interactive.skip)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .tint(.primary)
    .controlSize(.large)
    .disabled(!armed || disabled || model.isSending)
    .accessibilityIdentifier("interactive.skip")
  }
}

/// Don't share: refuse the request outright. The bot is told the person chose not to give it
/// (`4041 cannot_show` with reason `declined`, contract §3), which is neither a skip nor a failure.
/// A plain, quiet button: never the default, and with its own words, not the agent's.
struct DeclineButton: View {
  let model: InteractiveModel
  let armed: Bool
  var onDeclined: () -> Void = {}

  var body: some View {
    Button {
      guard armed else {
        return
      }

      Task {
        if await model.cannotShow(reason: CannotShowReason.declined) {
          onDeclined()
        }
      }
    } label: {
      Text(NativeStrings.Interactive.decline)
        .font(.callout)
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderless)
    .foregroundStyle(.secondary)
    .disabled(!armed || model.isSending)
    .accessibilityHint(NativeStrings.Interactive.declineHint)
    .accessibilityIdentifier("interactive.decline")
  }
}

/// For 400 ms after a sheet comes up nothing can be pressed, so a sheet that appears under a moving
/// finger cannot answer a question nobody read.
struct InteractiveTapGuard: ViewModifier {
  @Binding var armed: Bool
  let id: String

  /// How long after the sheet appears its buttons stay off.
  static let tapGuard: Duration = .milliseconds(400)

  func body(content: Content) -> some View {
    content
      .task(id: id) {
        armed = false
        try? await Task.sleep(for: Self.tapGuard)
        armed = !Task.isCancelled
      }
  }
}

// MARK: - Notices

/// The chat's line about a request that ended without the person's answer, or one this app could not
/// show. Nothing when there is none.
public struct InteractiveNoticeView: View {
  let model: InteractiveModel

  public init(model: InteractiveModel) {
    self.model = model
  }

  public var body: some View {
    if let entry = model.notice {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(Self.text(entry.notice, bot: model.botName), systemImage: Self.icon(entry.notice))
          .font(.footnote)
          .lineLimit(4)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Button {
          model.dismissNotice()
        } label: {
          Image(systemName: "xmark")
            .accessibilityLabel(NativeStrings.Interactive.close)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("interactive.notice.dismiss")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(.bar)
      .clipped()
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("interactive.notice")
    }
  }

  static func icon(_ notice: InteractiveNotice) -> String {
    switch notice {
    case .expired: "clock.badge.xmark"
    case .withdrawn: "xmark.circle"
    case .mayNotHaveArrived: "exclamationmark.triangle"
    case .answeredElsewhere: "person.2"
    case .notAllowed: "hand.raised"
    case .lapsed: "wifi.exclamationmark"
    case .cannotShow: "exclamationmark.bubble"
    }
  }

  /// On the chat, where the bot has to be named (`bot` already cleaned).
  static func text(_ notice: InteractiveNotice, bot: String) -> String {
    switch notice {
    case .cannotShow(_, let reason):
      // A refused permission or a missing position has words of its own; anything else is the general line.
      NativeStrings.Interactive.cannotShowNotice(reason: reason, bot: bot) ?? NativeStrings.Interactive.cannotShow(bot)
    default: sheetText(notice)
    }
  }

  /// In the sheet, under the bot's own title.
  static func sheetText(_ notice: InteractiveNotice) -> String {
    switch notice {
    case .expired: NativeStrings.SecureInput.expired
    case .mayNotHaveArrived: NativeStrings.SecureInput.mayNotHaveArrived
    case .lapsed: NativeStrings.SecureInput.lapsed
    case .answeredElsewhere: NativeStrings.Interactive.answeredElsewhere
    case .notAllowed: NativeStrings.Interactive.notAllowed
    case .withdrawn, .cannotShow: NativeStrings.SecureInput.withdrawn
    }
  }
}
