import HermieCore
import SwiftUI

/// The dot next to a cron or a run: static, never animated, and said aloud by its label.
struct CronStatusDot: View {
  enum Tone {
    case ok, failed, paused, pending

    var color: Color {
      switch self {
      case .ok: .green
      case .failed: .red
      case .paused: .gray
      case .pending: .orange
      }
    }
  }

  let tone: Tone
  var size: CGFloat = 10

  var body: some View {
    Circle()
      .fill(tone.color)
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

extension CronStatus {
  var tone: CronStatusDot.Tone {
    switch self {
    case .ok: .ok
    case .failed: .failed
    case .paused: .paused
    case .pending: .pending
    }
  }
}

extension CronRun.Outcome {
  var tone: CronStatusDot.Tone {
    switch self {
    case .ok: .ok
    case .failed: .failed
    case .running: .pending
    case .other: .paused
    }
  }
}

/// A question a cron action asks before it happens: Run now fires a real turn against a real gateway
/// and Delete has no undo.
enum CronConfirmation: Identifiable {
  case run(CronJob)
  case delete(CronJob)

  var id: String {
    switch self {
    case .run(let job): "run:\(job.id)"
    case .delete(let job): "delete:\(job.id)"
    }
  }

  var job: CronJob {
    switch self {
    case .run(let job), .delete(let job): job
    }
  }
}

extension View {
  /// The confirmation of Run now and Delete, and the alert that says what the gateway refused.
  func cronConfirmations(
    _ confirming: Binding<CronConfirmation?>,
    model: CronsModel,
    onDeleted: @escaping (CronJob) -> Void = { _ in }
  ) -> some View {
    modifier(CronConfirmations(confirming: confirming, model: model, onDeleted: onDeleted))
  }
}

private struct CronConfirmations: ViewModifier {
  @Binding var confirming: CronConfirmation?
  let model: CronsModel
  let onDeleted: (CronJob) -> Void

  func body(content: Content) -> some View {
    content
      .confirmationDialog(
        title,
        isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
        titleVisibility: .visible,
        presenting: confirming
      ) { confirmation in
        switch confirmation {
        case .run(let job):
          Button(Strings.Cron.ConfirmRun.confirm) {
            Task { await model.runNow(job) }
          }
          Button(Strings.Cron.ConfirmRun.cancel, role: .cancel) {}
        case .delete(let job):
          Button(Strings.Cron.ConfirmDelete.confirm, role: .destructive) {
            Task {
              if await model.remove(job) {
                onDeleted(job)
              }
            }
          }
          Button(Strings.Cron.ConfirmDelete.cancel, role: .cancel) {}
        }
      } message: { confirmation in
        switch confirmation {
        case .run: Text(Strings.Cron.ConfirmRun.body)
        case .delete: Text(Strings.Cron.ConfirmDelete.body)
        }
      }
      .alert(
        Strings.Cron.title,
        isPresented: Binding(get: { model.failure != nil }, set: { if !$0 { model.dismissFailure() } })
      ) {
        Button(Strings.App.Common.dismiss, role: .cancel) {}
      } message: {
        Text(verbatim: NativeStrings.Conversations.actionFailed(message: model.failure ?? ""))
      }
  }

  private var title: String {
    switch confirming {
    case .run(let job)?: Strings.Cron.ConfirmRun.title(name: job.name)
    case .delete(let job)?: Strings.Cron.ConfirmDelete.title(name: job.name)
    case nil: ""
    }
  }
}

/// What the editor sheet is opened on: a new cron, or one being edited.
struct CronEditing: Identifiable {
  let id = UUID()
  let job: CronJob?
}
