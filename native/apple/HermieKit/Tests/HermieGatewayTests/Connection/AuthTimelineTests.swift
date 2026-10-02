import HermieProtocol
import Synchronization
import Testing

@testable import HermieGateway

// The port of `packages/gateway-client/src/auth-timeline.test.ts`.

@Suite("AuthTimeline")
struct AuthTimelineTests {
  @Test("keeps only the most recent events")
  func keepsTheMostRecentEvents() {
    let timeline = AuthTimeline(size: 3)

    for event: AuthEventName in [.dialStart, .ticketMinted, .dialReady, .wsClosed] {
      timeline.record(AuthEvent(event))
    }

    #expect(timeline.snapshot().entries.map(\.event.event) == [.ticketMinted, .dialReady, .wsClosed])
  }

  @Test("records the fields that carry a value and nothing else")
  func recordsOnlyFieldsWithAValue() {
    let timeline = AuthTimeline(now: { 1_700_000_000_000 })

    timeline.record(AuthEvent(.wsClosed, closeCode: 4401))

    #expect(
      timeline.snapshot().entries.first
        == AuthTimelineEntry(at: 1_700_000_000_000, event: AuthEvent(.wsClosed, closeCode: 4401))
    )
  }

  @Test("hands the whole snapshot to the sink on every record")
  func handsTheSnapshotToTheSink() {
    let snapshots = Recorded<AuthTimelineSnapshot>()
    let timeline = AuthTimeline(sink: { snapshot in snapshots.append(snapshot) })

    timeline.record(AuthEvent(.refreshStart))
    timeline.record(AuthEvent(.refreshOK))

    #expect(snapshots.values.count == 2)
    #expect(snapshots.values.last?.entries.map(\.event.event) == [.refreshStart, .refreshOK])
  }

  @Test("survives a sink that throws, because recording a failure must not be one")
  func survivesAFailingSink() {
    // A Swift sink cannot throw; one that fails to persist simply returns.
    let timeline = AuthTimeline(sink: { _ in })

    timeline.record(AuthEvent(.dialStart))

    #expect(timeline.snapshot().entries.count == 1)
  }

  @Test("rounds the token lifetime it records")
  func roundsTheLifetime() {
    let timeline = AuthTimeline()

    timeline.record(AuthEvent(.tokenServed, expiresIn: 3599.5))
    timeline.record(AuthEvent(.tokenServed, expiresIn: -0.6))

    #expect(timeline.snapshot().entries.map(\.event.expiresIn) == [3600, -1])
  }

  @Suite("signOut attribution")
  struct SignOutAttribution {
    @Test("reads back to the cause the coordinator recorded")
    func readsBackToTheCause() {
      let timeline = AuthTimeline()

      timeline.record(AuthEvent(.dialReady))
      timeline.record(AuthEvent(.wsClosed, closeCode: 4401))
      timeline.record(AuthEvent(.refreshFailed, status: 401, kind: .auth))
      timeline.record(AuthEvent(.tokenCleared, reason: .refreshRejected))
      timeline.signOut(.rejectedAfterRefresh)

      #expect(timeline.signOutReason == .refreshRejected)
    }

    @Test("tells a transport failure apart from a rejected grant")
    func tellsATransportFailureApart() {
      let timeline = AuthTimeline()

      timeline.record(AuthEvent(.refreshFailed, kind: .network))
      timeline.signOut(.rejectedAfterRefresh)

      #expect(timeline.signOutReason == .refreshFailed)
    }

    @Test("blames an unreadable store when that is the last thing that happened")
    func blamesAnUnreadableStore() {
      let timeline = AuthTimeline()

      timeline.record(AuthEvent(.tokenReadFailed))
      timeline.signOut(.rejectedAfterRefresh)

      #expect(timeline.signOutReason == .tokenUnreadable)
    }

    /// A refresh that failed, was retried and succeeded must not be dug up to
    /// explain a sign-out an hour later.
    @Test("does not reach back past the last healthy dial")
    func stopsAtTheLastHealthyDial() {
      let timeline = AuthTimeline()

      timeline.record(AuthEvent(.refreshFailed, status: 401, kind: .auth))
      timeline.record(AuthEvent(.dialReady))
      timeline.record(AuthEvent(.wsClosed, closeCode: 4401))
      timeline.signOut(.rejectedAfterRefresh)

      #expect(timeline.signOutReason == .rejectedAfterRefresh)
    }
  }

  @Suite("restore")
  struct Restore {
    @Test("adopts a snapshot written before a restart")
    func adoptsASnapshot() {
      let timeline = AuthTimeline()

      timeline.restore([
        "events": [["at": 5, "event": "signin.required", "reason": "refresh_rejected"]],
        "lastSignOut": ["at": 5, "reason": "refresh_rejected"]
      ])

      #expect(timeline.signOutReason == .refreshRejected)
      #expect(timeline.snapshot().entries.count == 1)
    }

    @Test("drops entries an older build may have written in another shape")
    func dropsEntriesOfAnotherShape() {
      let timeline = AuthTimeline()

      timeline.restore(["events": ["dial.start", nil, 42, ["event": "ws.closed"], ["at": 1, "event": "dial.ready"]]])

      #expect(timeline.snapshot().entries == [AuthTimelineEntry(at: 1, event: AuthEvent(.dialReady))])
    }

    @Test("ignores a blob that is not a snapshot at all")
    func ignoresANonSnapshot() {
      let timeline = AuthTimeline()

      timeline.restore("signed out")
      timeline.restore(nil)
      timeline.restore(.null)

      #expect(timeline.snapshot() == AuthTimelineSnapshot())
    }
  }
}
