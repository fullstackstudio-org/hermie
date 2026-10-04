import Foundation
import HermieProtocol
import Observation

/**
 The Connectors page's state: one bot's connectors with their connection state, and the walk that
 connects one.

 ## The walk

 `connect` asks the gateway to start an authorisation, hands the link at `targets[].connect_url` to the
 system browser, and re-reads the operation until that target settles, the operation settles under it,
 or the walk gives up. A gateway that answers an operation with no usable link for the slug that was
 asked for is a failure the person is told about, not something to wait out: without a link there is
 nothing for them to do and the poll would run to the deadline.

 Snapshots are ordered by `seq` where the gateway sends one: the status read and the gateway's own
 account watcher race, and applying a stale snapshot would walk a connected target back to
 `initiated`. An operation that settles without the target settling (Continue, the deadline, a session
 that went away) is "not completed", not a failure worth a red line.

 The link is the gateway's text and goes to the person's browser: https only, a host, and no user or
 password before it (`AuthorisationLink`).

 There is no disconnect: the gateway has none, and the page says whose decision it is.

 Every text here is the gateway's or a vendor's: plain text, never Markdown. A read that a newer one
 overtook is dropped.
 */
@MainActor
@Observable
public final class ConnectorsModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    /// Connectors are switched off: a successful answer that says so, not an empty account.
    case unavailable
    case failed(String)
  }

  /// How the last walk ended, for the connector it was about.
  public enum Notice: Equatable, Sendable {
    case connected(String)
    case failed(String)
    case expired
    case skipped
    /// The gateway opened an authorisation and sent no link for the connector.
    case noLink
    /// The link is not an https link, or the system would not open it.
    case linkRefused
    /// The list could not be read again.
    case readFailed(String)
  }

  /// The bot the page is about; `nil` reads the gateway's own.
  public private(set) var profile: String?
  public private(set) var phase = Phase.loading
  public private(set) var connectors: [ConnectorItem] = []
  /// The connector whose walk is running.
  public private(set) var connecting: String?
  public private(set) var notice: Notice?

  @ObservationIgnored private let service: ConnectorsService
  @ObservationIgnored private let pollInterval: Duration
  @ObservationIgnored private let maxPolls: Int
  @ObservationIgnored private var round = 0
  /// The operation of the walk that is running, which `wake()` names.
  @ObservationIgnored private var openOperation: String?

  /// - Parameters:
  ///   - pollInterval: how often the operation is re-read; the gateway's own account watcher runs at 1 Hz.
  ///     Zero (a test's) waits for no time at all.
  ///   - maxPolls: how many reads before the walk gives up, a ceiling for a gateway that never answers
  ///     (the operation's own deadline is what normally ends it): six minutes at the default.
  public init(
    service: ConnectorsService, profile: String?, pollInterval: Duration = .seconds(1), maxPolls: Int = 360
  ) {
    self.service = service
    self.profile = profile
    self.pollInterval = pollInterval
    self.maxPolls = maxPolls
  }

  /// Wait for the next poll: the interval, or just a turn of the executor where the interval is zero
  /// (a test's). Not an injected closure: the Swift 6.4 runtime aborts on calling a stored `async`
  /// closure here the first time it really suspends.
  private func waitForNextPoll() async {
    if pollInterval > .zero {
      try? await Task.sleep(for: pollInterval)
    } else {
      await Task.yield()
    }
  }

  // MARK: Reading

  public func connector(_ slug: String) -> ConnectorItem? {
    connectors.first { $0.slug == slug }
  }

  public func setProfile(_ profile: String?) async {
    guard self.profile != profile else {
      return
    }

    self.profile = profile
    notice = nil
    await load()
  }

  /// Read the list. A list already on screen stays while it is read again.
  public func load() async {
    round += 1
    let mine = round

    do {
      let list = try await service.list(profile: profile)

      guard round == mine else {
        return
      }

      connectors = list.connectors
      phase = list.available ? .ready : .unavailable
    } catch {
      guard round == mine else {
        return
      }

      if phase == .ready {
        notice = .readFailed(CapabilityText.words(of: error))
      } else {
        phase = .failed(CapabilityText.words(of: error))
      }
    }
  }

  public func dismissNotice() {
    notice = nil
  }

  /// The person is back from the browser: tell the gateway so it reads the account now.
  public func wake() async {
    guard let operation = openOperation else {
      return
    }

    await service.wake(operation, profile: profile)
  }

  // MARK: Connecting

  /// Connect (or, with `reconnect`, switch the account of) one connector. `open` hands the link to the
  /// system browser and answers whether it was opened. True when the connector is connected.
  ///
  /// `open` is `@escaping` although the walk never stores it: it is held across the walk's
  /// suspensions, and the Swift 6.4 runtime aborts on a non-escaping closure that outlives a real one.
  @discardableResult
  public func connect(_ slug: String, reconnect: Bool = false, open: @escaping @MainActor (URL) -> Bool) async -> Bool {
    guard connecting == nil else {
      return false
    }

    connecting = slug
    notice = nil
    defer {
      connecting = nil
      openOperation = nil
    }

    let outcome = await walk(slug, reconnect: reconnect, open: open)

    switch outcome {
    case .connected: notice = .connected(connector(slug)?.label ?? slug)
    case .failed(let words): notice = .failed(words)
    case .expired: notice = .expired
    case .skipped: notice = .skipped
    case .none: break
    }

    await load()

    return outcome == .connected
  }

  /// How a walk ended, or `nil` where it ended with a notice of its own already set.
  private func walk(_ slug: String, reconnect: Bool, open: @escaping @MainActor (URL) -> Bool) async -> ConnectOutcome? {
    let started: ConnectorOperation

    do {
      started = try await service.connect(slug, reconnect: reconnect, profile: profile)
    } catch {
      return .failed(CapabilityText.words(of: error))
    }

    openOperation = started.id

    let target = started.target(slug)

    // Already done before the browser was ever opened: a no-auth toolkit mints `connected` straight
    // away, and running the flow would be a detour through a page the vendor would bounce back.
    if target?.state == .connected {
      return .connected
    }

    guard let link = AuthorisationLink(target?.connectURL) else {
      notice = target?.connectURL == nil ? .noLink : .linkRefused

      return nil
    }

    guard open(link.url) else {
      notice = .linkRefused

      return nil
    }

    return await follow(slug, operation: started.id, startedSeq: started.seq)
  }

  /// Re-read the operation until the target settles, the operation settles under it, or the walk gives
  /// up. Frames are ordered by `seq` where the gateway sends one.
  private func follow(_ slug: String, operation: String, startedSeq: Int?) async -> ConnectOutcome? {
    var seen = startedSeq

    for _ in 0..<maxPolls {
      await waitForNextPoll()

      if Task.isCancelled {
        // The person left the page: nothing is owed an answer, and the gateway's own watcher carries on.
        return nil
      }

      let frame: ConnectorOperation

      do {
        frame = try await service.status(of: operation, profile: profile)
      } catch {
        return .failed(CapabilityText.words(of: error))
      }

      // A frame with no `seq`, or one before any was seen, cannot be ordered and is taken. (Written
      // without a closure over `seen`: the Swift 6.4 runtime aborts on one held across a suspension.)
      var isNewer = true

      if let new = frame.seq, let old = seen {
        isNewer = new > old
      }

      if isNewer {
        seen = frame.seq

        if let target = frame.target(slug), let outcome = ConnectOutcome(settled: target) {
          return outcome
        }

        // The operation settled without this target settling. That happens when the person answered
        // Continue, when the deadline struck, or when the session went away underneath it: none of
        // which is a failure worth a red line, and all of which mean nothing more is coming.
        if frame.settled {
          return .skipped
        }
      }
    }

    return .expired
  }
}
