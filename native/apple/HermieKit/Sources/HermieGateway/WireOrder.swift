import HermieProtocol

// Wire order across the connection's outputs.
//
// The TypeScript client hands events, server requests and RPC results to its
// callers synchronously, in the order the frames arrived: by the time a
// `session.resume` promise settles, every event that preceded the answer on
// the wire has been handled, and none that followed it. Here the three come
// out of different places (`events`, `serverRequests`, the awaiting caller),
// each drained by its own task, so arrival order is no longer the order a
// consumer sees them in. A consumer could apply a resume snapshot after deltas
// that followed it on the wire, and lose them.
//
// So every inbound frame gets an index when the actor reads it, counting up
// from 1 for the connection's whole life, across reconnects. The contract:
//
//   A consumer orders or discards by wire index. An RPC result with index N
//   reflects every frame with index < N, and none with index > N.
//
// What carries which index:
//
// - A live event: the index of its own frame.
// - An event replayed by `session.events.since`: the index of the response
//   that carried it (it precedes everything that frame's successors say).
// - A live frame parked while a replay was in flight: its own index, though it
//   is dispatched after the replay's events.
// - A server request: its own frame's index, or, re-delivered from a result's
//   `open_requests`, the index of that result.
// - An RPC result: the index of its response frame (`requestReply`).

/// A gateway event and the wire index of the frame that brought it.
public struct WireEvent: Sendable, Equatable {
  public let index: UInt64
  public let event: GatewayEvent

  public init(index: UInt64, event: GatewayEvent) {
    self.index = index
    self.event = event
  }
}

/// An RPC result and the wire index of the response frame that carried it.
public struct RPCReply<Result: Sendable>: Sendable {
  public let index: UInt64
  public let result: Result
  /// The interactive request methods (`input.form`, ...) whose open requests this answer's
  /// `open_requests` lists in full: the ones the gateway had accepted from this socket before the
  /// call went out (its answer to the second `client.capabilities` call was in). The gateway lists
  /// an interactive request only to a socket that advertised its method, so a list read before then
  /// says nothing about them. Empty for none.
  public let listedRequests: Set<String>

  public init(index: UInt64, result: Result, listedRequests: Set<String> = []) {
    self.index = index
    self.result = result
    self.listedRequests = listedRequests
  }
}

extension RPCReply: Equatable where Result: Equatable {}
