import HermieCore
import SwiftUI

/**
 The emergency stop (NX-16) as a sheet: it reads what is running, asks "Stop all N running turns?",
 interrupts every one of them at once, and says what it stopped. One sheet for the three steps, so
 the menu command (`AppSheet.emergencyStop`) and the inbox's toolbar button show the same thing.

 The sheet cannot be dismissed while the turns are being stopped; before that, and after, it can.
 */
struct EmergencyStopSheet: View {
  @Environment(\.liveWiring) private var wiring
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      if let model = wiring?.emergencyStop {
        EmergencyStopContent(model: model, close: { dismiss() })
      } else {
        EmptyState(
          NativeStrings.EmergencyStop.idleTitle,
          systemImage: "stop.circle",
          message: Text(NativeStrings.EmergencyStop.idleMessage)
        ) {
          Button(Strings.App.Common.done) { dismiss() }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 420)
    #endif
    .accessibilityIdentifier("hermie.emergencyStop")
  }
}

/// The three steps over one model.
struct EmergencyStopContent: View {
  let model: EmergencyStopModel
  let close: () -> Void

  var body: some View {
    Group {
      switch model.phase {
      case .idle, .looking:
        ProgressView(NativeStrings.EmergencyStop.looking)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      case .confirming(let plan):
        confirmation(plan, stopping: false)
      case .stopping(let plan):
        confirmation(plan, stopping: true)
      case .finished(let summary):
        SummaryList(summary: summary)
      }
    }
    .navigationTitle(NativeStrings.EmergencyStop.button)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .toolbar { toolbar }
    .interactiveDismissDisabled(model.isBusy)
    .task { await model.begin() }
    .onDisappear {
      model.cancel()
      model.dismiss()
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    switch model.phase {
    case .idle, .looking, .confirming:
      ToolbarItem(placement: .cancellationAction) {
        Button(Strings.App.Common.cancel) {
          model.cancel()
          close()
        }
        .keyboardShortcut(.cancelAction)
      }
    case .stopping:
      ToolbarItem(placement: .cancellationAction) { EmptyView() }
    case .finished:
      ToolbarItem(placement: .confirmationAction) {
        Button(Strings.App.Common.done) {
          model.dismiss()
          close()
        }
        .keyboardShortcut(.defaultAction)
      }
    }
  }

  private func confirmation(_ plan: StopPlan, stopping: Bool) -> some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: 8) {
          Text(NativeStrings.EmergencyStop.confirmTitle(plan.total))
            .font(.title3.bold())
            .accessibilityAddTraits(.isHeader)

          Text(NativeStrings.EmergencyStop.confirmMessage)
            .foregroundStyle(.secondary)
        }
        .listRowBackground(Color.clear)
      }

      ForEach(plan.entries) { entry in
        Section(plan.entries.count > 1 ? entry.gatewayName : "") {
          ForEach(entry.turns) { turn in
            Text(StopNames.name(of: turn))
          }
        }
      }

      Notes(unreachable: plan.unreachable, notAsked: plan.notAsked, incomplete: plan.incomplete)

      Section {
        if stopping {
          HStack(spacing: 8) {
            ProgressView()
            Text(NativeStrings.EmergencyStop.stopping)
          }
        } else {
          Button(role: .destructive) {
            Task { await model.confirm() }
          } label: {
            Text(NativeStrings.EmergencyStop.button)
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("hermie.emergencyStop.confirm")
        }
      }
      .listRowBackground(Color.clear)
    }
  }
}

/// What the stop did: a title, the counts, and one line per turn.
private struct SummaryList: View {
  let summary: StopSummary

  var body: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: 6) {
          Text(title)
            .font(.title3.bold())
            .accessibilityAddTraits(.isHeader)

          if summary.wasIdle {
            Text(NativeStrings.EmergencyStop.idleMessage)
              .foregroundStyle(.secondary)
          } else {
            Text(counts)
              .foregroundStyle(.secondary)
          }
        }
        .listRowBackground(Color.clear)
      }

      let groups = Dictionary(grouping: summary.records, by: \.gatewayId)
      let order = summary.records.map(\.gatewayId).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }

      ForEach(order, id: \.self) { gatewayId in
        let records = groups[gatewayId] ?? []

        Section(order.count > 1 ? records.first?.gatewayName ?? "" : "") {
          ForEach(records) { record in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Image(systemName: icon(record.outcome))
                .foregroundStyle(color(record.outcome))
                .accessibilityHidden(true)

              VStack(alignment: .leading, spacing: 2) {
                Text(StopNames.name(of: record.turn))

                if let detail = StopNames.detail(of: record.turn) {
                  Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Text(NativeStrings.EmergencyStop.outcome(record.outcome))
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
            .accessibilityElement(children: .combine)
          }
        }
      }

      Notes(
        unreachable: summary.unreachable, notAsked: summary.notAsked, incomplete: summary.incomplete,
        cronRunsKeepRunning: summary.usedStopEverything)
    }
    .accessibilityIdentifier("hermie.emergencyStop.summary")
  }

  private var title: String {
    if summary.wasIdle {
      NativeStrings.EmergencyStop.idleTitle
    } else if summary.failed > 0 {
      NativeStrings.EmergencyStop.someFailed
    } else {
      NativeStrings.EmergencyStop.allStopped
    }
  }

  private var counts: String {
    StopCounts.line(of: summary)
  }

  private func icon(_ outcome: StopOutcome) -> String {
    switch outcome {
    case .stopped: "checkmark.circle.fill"
    case .alreadyDone: "minus.circle"
    case .notConnected, .failed: "exclamationmark.triangle.fill"
    }
  }

  private func color(_ outcome: StopOutcome) -> Color {
    switch outcome {
    case .stopped: .green
    case .alreadyDone: .secondary
    case .notConnected, .failed: .orange
    }
  }
}

/// What the stop could not reach, so a person is never left thinking everything is quiet.
private struct Notes: View {
  let unreachable: Int
  let notAsked: [String]
  let incomplete: Bool
  /// The stop was made in one call, which leaves scheduled (cron) runs alone: said, so nobody thinks they stopped.
  var cronRunsKeepRunning = false

  var body: some View {
    if unreachable > 0 || !notAsked.isEmpty || incomplete || cronRunsKeepRunning {
      Section {
        if unreachable > 0 {
          Text(NativeStrings.EmergencyStop.unreachable(unreachable))
        }

        if !notAsked.isEmpty {
          Text(NativeStrings.EmergencyStop.notAsked(notAsked.joined(separator: ", ")))
        }

        if incomplete {
          Text(NativeStrings.EmergencyStop.incomplete)
        }

        if cronRunsKeepRunning {
          Text(NativeStrings.EmergencyStop.cronNote)
            .accessibilityIdentifier("hermie.emergencyStop.cronNote")
        }
      }
      .font(.footnote)
      .foregroundStyle(.secondary)
    }
  }
}

/// How a turn is named in the lists.
enum StopNames {
  static func name(of turn: RunningTurn) -> String {
    if !turn.botName.isEmpty {
      return turn.botName
    }

    return turn.title.isEmpty ? NativeStrings.EmergencyStop.unnamed : turn.title
  }

  /// What more is known of a turn beside its name: its title where the bot's name leads, and where it was
  /// started from. Nil where there is nothing to add.
  static func detail(of turn: RunningTurn) -> String? {
    var parts: [String] = []

    if !turn.botName.isEmpty, !turn.title.isEmpty {
      parts.append(turn.title)
    }

    if !turn.source.isEmpty {
      parts.append(turn.source)
    }

    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

/// The summary's counts, as one line.
enum StopCounts {
  static func line(of summary: StopSummary) -> String {
    var parts: [String] = []

    if summary.stopped > 0 { parts.append(NativeStrings.EmergencyStop.stoppedCount(summary.stopped)) }
    if summary.alreadyDone > 0 { parts.append(NativeStrings.EmergencyStop.alreadyDoneCount(summary.alreadyDone)) }
    if summary.alreadyIdleCount > 0 { parts.append(NativeStrings.EmergencyStop.alreadyIdleCount(summary.alreadyIdleCount)) }
    if summary.notAllowed > 0 { parts.append(NativeStrings.EmergencyStop.notAllowedCount(summary.notAllowed)) }
    if summary.failed > 0 { parts.append(NativeStrings.EmergencyStop.failedCount(summary.failed)) }

    return parts.joined(separator: " · ")
  }
}
