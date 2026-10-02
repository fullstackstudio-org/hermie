import Foundation

/// One client→server JSON-RPC method: its wire name and the types of its params and result.
///
/// ```swift
/// let request = JSONRPCRequest(id: ids.next(), RPC.PromptSubmit.self, params: .init(sessionID: sid, text: text))
/// let result = response.result(of: RPC.PromptSubmit.self)   // PromptSubmitResult?
/// ```
///
/// Long-tail methods use `JSONValue` for both until a feature needs them typed.
public protocol RPCMethod: Sendable {
  associatedtype Params: JSONConvertible
  associatedtype Result: JSONConvertible
  static var name: String { get }
}

/// The method catalogue. Names and shapes follow `RpcMethods` in
/// `packages/hermes-shared/src/gateway-contract.generated.ts`.
public enum RPC {
  // MARK: Sessions

  public enum SessionCreate: RPCMethod {
    public static let name = "session.create"
    public typealias Params = SessionCreateParams
    public typealias Result = SessionCreateResult
  }

  public enum SessionResume: RPCMethod {
    public static let name = "session.resume"
    public typealias Params = SessionResumeParams
    public typealias Result = SessionResumeResult
  }

  public enum SessionList: RPCMethod {
    public static let name = "session.list"
    public typealias Params = SessionListParams
    public typealias Result = SessionListResult
  }

  public enum SessionHistory: RPCMethod {
    public static let name = "session.history"
    public typealias Params = SessionParams
    public typealias Result = SessionHistoryResult
  }

  public enum SessionEventsSince: RPCMethod {
    public static let name = "session.events.since"
    public typealias Params = SessionEventsSinceParams
    public typealias Result = SessionEventsSinceResult
  }

  public enum SessionInterrupt: RPCMethod {
    public static let name = "session.interrupt"
    public typealias Params = SessionInterruptParams
    public typealias Result = SessionInterruptResult
  }

  public enum SessionSteer: RPCMethod {
    public static let name = "session.steer"
    public typealias Params = SessionCorrectionParams
    public typealias Result = SessionCorrectionResult
  }

  public enum SessionClose: RPCMethod {
    public static let name = "session.close"
    public typealias Params = SessionParams
    public typealias Result = SessionCloseResult
  }

  public enum SessionDelete: RPCMethod {
    public static let name = "session.delete"
    public typealias Params = SessionParams
    public typealias Result = SessionDeleteResult
  }

  public enum SessionTitle: RPCMethod {
    public static let name = "session.title"
    public typealias Params = SessionTitleParams
    public typealias Result = SessionTitleResult
  }

  public enum SessionSetHidden: RPCMethod {
    public static let name = "session.set_hidden"
    public typealias Params = SessionSetHiddenParams
    public typealias Result = SessionSetHiddenResult
  }

  public enum SessionBranch: RPCMethod {
    public static let name = "session.branch"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum SessionUsage: RPCMethod {
    public static let name = "session.usage"
    public typealias Params = SessionParams
    public typealias Result = JSONValue
  }

  public enum SessionActiveList: RPCMethod {
    public static let name = "session.active_list"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  // MARK: Prompts

  public enum PromptSubmit: RPCMethod {
    public static let name = "prompt.submit"
    public typealias Params = PromptSubmitParams
    public typealias Result = PromptSubmitResult
  }

  public enum ImageAttachBytes: RPCMethod {
    public static let name = "image.attach_bytes"
    public typealias Params = ImageAttachBytesParams
    public typealias Result = AttachedImageResult
  }

  // MARK: Questions

  public enum ApprovalRespond: RPCMethod {
    public static let name = "approval.respond"
    public typealias Params = ApprovalRespondParams
    public typealias Result = ApprovalRespondResult
  }

  public enum ApprovalPending: RPCMethod {
    public static let name = "approval.pending"
    public typealias Params = SessionParams
    public typealias Result = ApprovalPendingResult
  }

  public enum ApprovalReceived: RPCMethod {
    public static let name = "approval.received"
    public typealias Params = ApprovalReceivedParams
    public typealias Result = ApprovalReceivedResult
  }

  public enum ClarifyLock: RPCMethod {
    public static let name = "clarify.lock"
    public typealias Params = ClarifyLockParams
    public typealias Result = ClarifyLockResult
  }

  public enum RequestAnswer: RPCMethod {
    public static let name = "request.answer"
    public typealias Params = RequestAnswerParams
    public typealias Result = RequestAnswerResult
  }

  // MARK: Connection

  /// The heartbeat, sent with `{}` only when `gateway.ready` advertised `heartbeat: true`.
  public enum GatewayPing: RPCMethod {
    public static let name = "gateway.ping"
    public typealias Params = JSONValue
    public typealias Result = PingResult
  }

  /// Sent once per connection after `gateway.ready` with `{server_requests: true}`.
  public enum ClientCapabilities: RPCMethod {
    public static let name = "client.capabilities"
    public typealias Params = ClientCapabilitiesParams
    public typealias Result = ClientCapabilitiesResult
  }

  // MARK: Profiles

  public enum ProfilesList: RPCMethod {
    public static let name = "profiles.list"
    public typealias Params = ProfilesListParams
    public typealias Result = ProfilesListResult
  }

  public enum ProfilesGetAsset: RPCMethod {
    public static let name = "profiles.get_asset"
    public typealias Params = ProfilesGetAssetParams
    public typealias Result = ProfilesGetAssetResult
  }

  public enum ProfilesConfigure: RPCMethod {
    public static let name = "profiles.configure"
    public typealias Params = ProfilesConfigureParams
    public typealias Result = ProfilesConfigureResult
  }

  public enum ProfilesSetAsset: RPCMethod {
    public static let name = "profiles.set_asset"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ProfilesCreate: RPCMethod {
    public static let name = "profiles.create"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ProfilesDescribe: RPCMethod {
    public static let name = "profiles.describe"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  // MARK: Commands and configuration (long tail: JSON-backed)

  public enum CommandsCatalog: RPCMethod {
    public static let name = "commands.catalog"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum CompleteSlash: RPCMethod {
    public static let name = "complete.slash"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum SlashExec: RPCMethod {
    public static let name = "slash.exec"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum CommandDispatch: RPCMethod {
    public static let name = "command.dispatch"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ConfigGet: RPCMethod {
    public static let name = "config.get"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ConfigSet: RPCMethod {
    public static let name = "config.set"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ModelOptions: RPCMethod {
    public static let name = "model.options"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum AgentsList: RPCMethod {
    public static let name = "agents.list"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  // MARK: Delegation (long tail: JSON-backed)

  public enum DelegationStatus: RPCMethod {
    public static let name = "delegation.status"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum SubagentList: RPCMethod {
    public static let name = "subagent.list"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum SubagentTail: RPCMethod {
    public static let name = "subagent.tail"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum SubagentSteer: RPCMethod {
    public static let name = "subagent.steer"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum SubagentInterrupt: RPCMethod {
    public static let name = "subagent.interrupt"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  // MARK: Skills, MCP, connectors, cron (long tail: JSON-backed)

  public enum SkillsManage: RPCMethod {
    public static let name = "skills.manage"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum McpServersList: RPCMethod {
    public static let name = "mcp.servers.list"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum McpServersStatus: RPCMethod {
    public static let name = "mcp.servers.status"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum McpServersTest: RPCMethod {
    public static let name = "mcp.servers.test"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum McpServersOauthStart: RPCMethod {
    public static let name = "mcp.servers.oauth.start"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum McpServersOauthPoll: RPCMethod {
    public static let name = "mcp.servers.oauth.poll"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum McpServersOauthCancel: RPCMethod {
    public static let name = "mcp.servers.oauth.cancel"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ReloadMcp: RPCMethod {
    public static let name = "reload.mcp"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ConnectorsList: RPCMethod {
    public static let name = "connectors.list"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ConnectorsConnect: RPCMethod {
    public static let name = "connectors.connect"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum ConnectorsOperationStatus: RPCMethod {
    public static let name = "connectors.operation.status"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  /// Not in the vendored upstream contract; the fake gateway implements it.
  public enum ConnectorsOperationWake: RPCMethod {
    public static let name = "connectors.operation.wake"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  public enum CronManage: RPCMethod {
    public static let name = "cron.manage"
    public typealias Params = JSONValue
    public typealias Result = JSONValue
  }

  /// The wire name of every method in this catalogue.
  public static let allMethodNames: [String] = [
    SessionCreate.name, SessionResume.name, SessionList.name, SessionHistory.name,
    SessionEventsSince.name, SessionInterrupt.name, SessionSteer.name, SessionClose.name,
    SessionDelete.name, SessionTitle.name, SessionSetHidden.name, SessionBranch.name,
    SessionUsage.name, SessionActiveList.name, PromptSubmit.name, ImageAttachBytes.name,
    ApprovalRespond.name, ApprovalPending.name, ApprovalReceived.name, ClarifyLock.name,
    RequestAnswer.name, GatewayPing.name, ClientCapabilities.name, ProfilesList.name,
    ProfilesGetAsset.name, ProfilesConfigure.name, ProfilesSetAsset.name, ProfilesCreate.name,
    ProfilesDescribe.name, CommandsCatalog.name, CompleteSlash.name, SlashExec.name,
    CommandDispatch.name, ConfigGet.name, ConfigSet.name, ModelOptions.name,
    AgentsList.name, DelegationStatus.name, SubagentList.name, SubagentTail.name,
    SubagentSteer.name, SubagentInterrupt.name, SkillsManage.name, McpServersList.name,
    McpServersStatus.name, McpServersTest.name, McpServersOauthStart.name, McpServersOauthPoll.name,
    McpServersOauthCancel.name, ReloadMcp.name, ConnectorsList.name, ConnectorsConnect.name,
    ConnectorsOperationStatus.name, ConnectorsOperationWake.name, CronManage.name
  ]
}
