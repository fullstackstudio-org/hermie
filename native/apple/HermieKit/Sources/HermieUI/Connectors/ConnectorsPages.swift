import HermieCore
import SwiftUI

/**
 Settings → Connectors: the accounts a bot can sign in to on the person's behalf (`ConnectorsScreen`
 in the Expo app).

 The connectors of the bot's account with whether each is connected; a connector's page connects it
 (the gateway's authorisation page opens in the browser and the page follows the sign-in until it
 settles) or, where it is connected, connects another account. The gateway has no disconnect, and the
 page says whose decision that is rather than offering a control that could only fail. A bot or gateway
 with connectors switched off gets that sentence and not an empty list.

 The authorisation link is the gateway's text and is opened only if it is an https link with a host and
 no user or password before it. Every text here is the gateway's or a vendor's: plain text.
 */
struct ConnectorsSettingsEntry: View {
  var body: some View {
    CapabilityHost(identifier: "hermie.connectors.page") { session in
      ConnectorsPage(session: session)
    }
  }
}

struct ConnectorsPage: View {
  let session: GatewaySession

  @State private var model: ConnectorsModel
  @State private var bot: String?

  init(session: GatewaySession) {
    self.session = session

    let first = session.capabilityBots.first?.id

    _bot = State(initialValue: first)
    _model = State(initialValue: session.connectors(for: first))
  }

  var body: some View {
    let bots = session.capabilityBots

    Form {
      if !bots.isEmpty {
        Section {
          CapabilityBotPicker(bots: bots, selection: $bot, identifier: "hermie.connectors.bot")
        }
      }

      CapabilityNoticeSection(text: ConnectorsText.notice(model.notice), dismiss: model.dismissNotice)

      Section {
        switch model.phase {
        case .loading:
          CapabilityLoadingRow(text: Strings.Connectors.loading)
        case .failed(let words):
          CapabilityFailureRow(text: Strings.Connectors.failed(reason: words)) { Task { await model.load() } }
        case .unavailable:
          CapabilityStatusRow(
            text: Strings.Connectors.unavailable, symbol: "nosign", identifier: "hermie.connectors.unavailable")
          Text(Strings.Connectors.unavailableHint)
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        case .ready:
          if model.connectors.isEmpty {
            Text(Strings.Connectors.empty)
              .foregroundStyle(Color.primary)
              .accessibilityIdentifier("hermie.connectors.empty")
          }

          ForEach(model.connectors) { connector in
            NavigationLink {
              ConnectorPage(model: model, slug: connector.slug)
            } label: {
              ConnectorRowView(connector: connector, connecting: model.connecting == connector.slug)
            }
            .accessibilityIdentifier("hermie.connectors.connector.\(connector.slug)")
          }
        }
      } footer: {
        SettingsNote(Strings.Connectors.subtitle)
      }
    }
    .formStyle(.grouped)
    .navigationTitle(Strings.Connectors.title)
    .task(id: ObjectIdentifier(model)) { await model.load() }
    .onChange(of: bot) { _, now in
      Task { await model.setProfile(now) }
    }
    .refreshable { await model.load() }
    .accessibilityIdentifier("hermie.connectors.page")
  }
}

/// One connector in the list: its name, how it stands and, where the vendor says why, the reason.
struct ConnectorRowView: View {
  let connector: ConnectorItem
  let connecting: Bool

  var body: some View {
    let state = ConnectorsText.state(of: connector)

    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: connector.label)
      Text(verbatim: connecting ? Strings.Connectors.connecting : state)
        .font(.footnote)
        .foregroundStyle(Color.primary)
      if let reason = connector.statusReason {
        Text(Strings.Connectors.reason(text: reason))
          .font(.footnote)
          .foregroundStyle(Color.primary)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(connector.label)
    .accessibilityValue(connecting ? Strings.Connectors.connecting : state)
  }
}

/// One connector: what the gateway says of it, and the connect (or reconnect) walk.
struct ConnectorPage: View {
  let model: ConnectorsModel
  let slug: String

  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase
  @State private var walk: Task<Void, Never>?

  var body: some View {
    Group {
      if let connector = model.connector(slug) {
        content(connector)
      } else {
        Form {
          Section { CapabilityStatusRow(text: Strings.Connectors.empty, symbol: "tray") }
        }
        .formStyle(.grouped)
      }
    }
    .navigationTitle(model.connector(slug)?.label ?? slug)
    .onDisappear { walk?.cancel() }
    // Back from the browser: tell the gateway, so it reads the account now and not on its next tick.
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, model.connecting == slug {
        Task { await model.wake() }
      }
    }
    .accessibilityIdentifier("hermie.connectors.detail")
  }

  private func content(_ connector: ConnectorItem) -> some View {
    let walking = model.connecting == slug

    return Form {
      CapabilityNoticeSection(text: ConnectorsText.notice(model.notice), dismiss: model.dismissNotice)

      Section {
        LabeledContent(Strings.Connectors.Detail.slug) { Text(verbatim: connector.slug) }
        LabeledContent(Strings.Connectors.Detail.status) {
          Text(verbatim: ConnectorsText.state(of: connector))
        }
        if let status = connector.connectionStatus {
          LabeledContent(Strings.Connectors.Detail.title) { Text(verbatim: status) }
        }
        if let enabled = connector.enabled {
          LabeledContent(Strings.Connectors.Detail.enabled) {
            Text(enabled ? Strings.Connectors.Detail.yes : Strings.Connectors.Detail.no)
          }
        }
        if let reason = connector.statusReason {
          Text(Strings.Connectors.reason(text: reason))
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if !connector.description.isEmpty {
          Text(verbatim: connector.description)
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Section {
        if walking {
          CapabilityLoadingRow(text: Strings.Connectors.connecting)
        } else {
          Button(
            connector.connected ? Strings.Connectors.reconnect : Strings.Connectors.connect,
            systemImage: "link.badge.plus"
          ) { connect(reconnect: connector.connected) }
            .disabled(model.connecting != nil)
            .accessibilityIdentifier("hermie.connectors.connect")
        }
      } footer: {
        VStack(alignment: .leading, spacing: 6) {
          SettingsNote(Strings.Connectors.connectHint)
          // The gateway has no disconnect: whose decision it is, instead of a control that could
          // only fail.
          SettingsNote(Strings.Connectors.disconnect)
        }
      }
    }
    .formStyle(.grouped)
  }

  private func connect(reconnect: Bool) {
    walk?.cancel()
    walk = Task {
      await model.connect(slug, reconnect: reconnect) { url in
        openURL(url)

        return true
      }
    }
  }
}

/// The words of the Connectors pages, from the model's cases.
enum ConnectorsText {
  /// How a connector stands, as one phrase: connected, switched off, or not connected.
  static func state(of connector: ConnectorItem) -> String {
    if connector.connected {
      return Strings.Connectors.State.connected
    }

    if connector.enabled == false {
      return Strings.Connectors.State.disabled
    }

    return Strings.Connectors.State.notConnected
  }

  static func notice(_ notice: ConnectorsModel.Notice?) -> String? {
    switch notice {
    case .connected(let name): Strings.Connectors.connectOk(name: SecurePrompt.displayText(name, limit: SecurePrompt.nameLimit))
    case .failed(let words): Strings.Connectors.connectFailed(reason: words)
    case .expired: Strings.Connectors.connectExpired
    case .skipped: Strings.Connectors.connectSkipped
    case .noLink: Strings.Connectors.connectNoUrl
    case .linkRefused: NativeStrings.ConnectorsPage.linkRefused
    case .readFailed(let words): Strings.Connectors.failed(reason: words)
    case nil: nil
    }
  }
}
