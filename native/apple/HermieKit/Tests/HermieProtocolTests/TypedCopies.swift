import Foundation

@testable import HermieProtocol

// Rebuilds of typed views from an EMPTY object, through nothing but their typed properties.
//
// A view re-encodes losslessly by construction (it keeps its object), so a plain round
// trip proves only the envelope. These copies prove the typed MODEL: when a copy's canonical
// text equals the original's, every key the corpus carries has a typed property with the
// right spelling and the right type. A key without one shows up as a difference.

enum TypedCopy {
  static func body(_ body: GatewayEventBody) -> GatewayEventBody {
    switch body {
    case .messageStart: .messageStart(EmptyPayload())
    case .sessionsChanged: .sessionsChanged(EmptyPayload())
    case .cronChanged: .cronChanged(EmptyPayload())
    case .messageDelta(let p): .messageDelta(delta(p))
    case .reasoningAvailable(let p): .reasoningAvailable(delta(p))
    case .reasoningDelta(let p): .reasoningDelta(delta(p))
    case .thinkingDelta(let p): .thinkingDelta(delta(p))
    case .messageInterim(let p):
      .messageInterim(
        with(MessageInterimPayload()) { $0.text = p.text; $0.alreadyStreamed = p.alreadyStreamed; $0.rowID = p.rowID })
    case .messageComplete(let p): .messageComplete(complete(p))
    case .messageReaction(let p):
      .messageReaction(
        with(MessageReactionPayload()) {
          $0.rowID = p.rowID
          $0.reactions = p.reactions.map { $0.map(reaction) }
          $0.role = p.role
        })
    case .toolGenerating(let p): .toolGenerating(with(ToolGeneratingPayload()) { $0.name = p.name })
    case .toolStart(let p): .toolStart(toolStart(p))
    case .toolComplete(let p): .toolComplete(toolComplete(p))
    case .toolOutputRisk(let p):
      .toolOutputRisk(
        with(ToolOutputRiskPayload()) {
          $0.toolID = p.toolID
          $0.name = p.name
          $0.risk = p.risk
          $0.findings = p.findings
          $0.redacted = p.redacted
          $0.callRowID = p.callRowID
          $0.callIndex = p.callIndex
        })
    case .subagentSpawnRequested(let p): .subagentSpawnRequested(subagent(p))
    case .subagentStart(let p): .subagentStart(subagent(p))
    case .subagentProgress(let p): .subagentProgress(subagent(p))
    case .subagentThinking(let p): .subagentThinking(subagent(p))
    case .subagentTool(let p): .subagentTool(subagent(p))
    case .subagentComplete(let p): .subagentComplete(subagent(p))
    case .statusUpdate(let p): .statusUpdate(with(StatusUpdatePayload()) { $0.kind = p.kind; $0.text = p.text })
    case .todoUpdated(let p): .todoUpdated(with(TodoUpdatedPayload()) { $0.todos = p.todos; $0.revision = p.revision })
    case .sessionInfo(let p): .sessionInfo(info(p))
    case .sessionTitle(let p): .sessionTitle(with(SessionTitlePayload()) { $0.sessionID = p.sessionID; $0.title = p.title })
    case .sessionUsage(let p): .sessionUsage(with(SessionUsagePayload()) { $0.usage = p.usage.map(usage) })
    case .sessionReclaimed(let p):
      .sessionReclaimed(
        with(SessionReclaimedPayload()) {
          $0.sessionID = p.sessionID
          $0.storedSessionID = p.storedSessionID
          $0.reason = p.reason
        })
    case .requestCancel(let p):
      .requestCancel(with(RequestCancelPayload()) { $0.id = p.id; $0.method = p.method; $0.reason = p.reason })
    case .backgroundComplete(let p): .backgroundComplete(sideAgent(p))
    case .btwComplete(let p): .btwComplete(sideAgent(p))
    case .notice(let p):
      .notice(with(NoticePayload()) { $0.message = p.message; $0.detail = p.detail; $0.noticeKind = p.noticeKind })
    case .error(let p): .error(with(ErrorPayload()) { $0.message = p.message })
    case .gatewayReady(let p):
      .gatewayReady(
        with(GatewayReadyPayload()) {
          $0.skin = p.skin.map(skin)
          $0.changeEvents = p.changeEvents
          $0.replayEpoch = p.replayEpoch
          $0.heartbeat = p.heartbeat
        })
    case .notificationShow(let p):
      .notificationShow(
        with(NotificationShowPayload()) {
          $0.text = p.text
          $0.level = p.level
          $0.kind = p.kind
          $0.ttlMs = p.ttlMs
          $0.key = p.key
          $0.id = p.id
        })
    case .notificationClear(let p): .notificationClear(with(NotificationClearPayload()) { $0.key = p.key })
    case .connectionRequest(let p): .connectionRequest(connectionRequest(p))
    case .connectionUpdate(let p): .connectionUpdate(connectionUpdate(p))
    case .sessionResumeProgress(let p):
      .sessionResumeProgress(
        with(SessionResumeProgressPayload()) {
          $0.phase = p.phase
          $0.status = p.status
          $0.messageCount = p.messageCount
          $0.message = p.message
        })
    case .sessionControlUpdate(let p):
      .sessionControlUpdate(
        with(SessionControlUpdatePayload()) {
          $0.control = p.control.map { control in
            with(SessionControlSnapshot()) {
              $0.goal = control.goal
              $0.loop = control.loop
              $0.heartbeat = control.heartbeat
              $0.revision = control.revision
              $0.updatedAt = control.updatedAt
            }
          }
        })
    case .unknown: body
    }
  }

  static func connectionTarget(_ p: ConnectionOperationTarget) -> ConnectionOperationTarget {
    with(ConnectionOperationTarget()) {
      $0.name = p.name
      $0.kind = p.kind
      $0.action = p.action
      $0.state = p.state
      $0.detail = p.detail
      $0.instructions = p.instructions
      $0.discoveryError = p.discoveryError
      $0.connectURL = p.connectURL
      $0.connectionID = p.connectionID
      $0.attempt = p.attempt
      $0.requiredEnv = p.requiredEnv?.map { field in
        with(ConnectionTargetEnvField()) {
          $0.name = field.name
          $0.required = field.required
          $0.secret = field.secret
          $0.defaultValue = field.defaultValue
          $0.prompt = field.prompt
        }
      }
      $0.tools = p.tools
      $0.hint = p.hint
      $0.display = p.display
      $0.targetDescription = p.targetDescription
      $0.tier = p.tier
      $0.platforms = p.platforms
      $0.repo = p.repo
      $0.sha = p.sha
      $0.subdir = p.subdir
      $0.scan = p.scan.map { scan in with(CatalogScan()) { $0.status = scan.status; $0.summary = scan.summary } }
      $0.requirements = p.requirements
      $0.hasDesktopHalf = p.hasDesktopHalf
      $0.targetProfile = p.targetProfile
      $0.appState = p.appState
      $0.skill = p.skill
    }
  }

  static func connectionRequest(_ p: ConnectionRequestPayload) -> ConnectionRequestPayload {
    with(ConnectionRequestPayload()) {
      $0.opID = p.opID
      $0.seq = p.seq
      $0.deadlineAt = p.deadlineAt
      $0.timeoutSeconds = p.timeoutSeconds
      $0.targets = p.targets?.map(connectionTarget)
      $0.toolCallID = p.toolCallID
    }
  }

  static func connectionUpdate(_ p: ConnectionUpdatePayload) -> ConnectionUpdatePayload {
    with(ConnectionUpdatePayload()) {
      $0.opID = p.opID
      $0.seq = p.seq
      $0.deadlineAt = p.deadlineAt
      $0.settled = p.settled
      $0.settledAt = p.settledAt
      $0.settledBy = p.settledBy
      $0.targets = p.targets?.map(connectionTarget)
      $0.owner = p.owner.map { owner in with(ConnectorOwner()) { $0.type = owner.type; $0.sessionID = owner.sessionID } }
      $0.target = p.target
      $0.fromState = p.fromState
      $0.to = p.to
      $0.actor = p.actor
      $0.detail = p.detail
    }
  }

  static func event(_ event: GatewayEvent) -> GatewayEvent {
    GatewayEvent(body(event.body), sessionID: event.sessionID, seq: event.seq, turnID: event.turnID)
  }

  static func delta(_ p: StreamDeltaPayload) -> StreamDeltaPayload {
    with(StreamDeltaPayload()) { $0.text = p.text; $0.rendered = p.rendered; $0.verbose = p.verbose }
  }

  static func complete(_ p: MessageCompletePayload) -> MessageCompletePayload {
    with(MessageCompletePayload()) {
      $0.text = p.text
      $0.usage = p.usage.map(usage)
      $0.status = p.status
      $0.reasoning = p.reasoning
      $0.warning = p.warning
      $0.responsePreviewed = p.responsePreviewed
      $0.billing = p.billing
      $0.failureReason = p.failureReason
      $0.rendered = p.rendered
      $0.error = p.error
      $0.recoverable = p.recoverable
      $0.errorSurface = p.errorSurface.map(errorSurface)
      $0.partial = p.partial
      $0.rowID = p.rowID
      $0.persistedTurn = p.persistedTurn.map { turn in
        with(PersistedTurn()) {
          $0.complete = turn.complete
          $0.userRowID = turn.userRowID
          $0.finalAssistantRowID = turn.finalAssistantRowID
          $0.rowIDs = turn.rowIDs
        }
      }
    }
  }

  static func errorSurface(_ p: ErrorSurface) -> ErrorSurface {
    with(ErrorSurface()) {
      $0.layer = p.layer
      $0.code = p.code
      $0.retryable = p.retryable
      $0.provider = p.provider
      $0.model = p.model
    }
  }

  static func usage(_ p: Usage) -> Usage {
    with(Usage()) {
      $0.model = p.model
      $0.input = p.input
      $0.output = p.output
      $0.reasoning = p.reasoning
      $0.prompt = p.prompt
      $0.completion = p.completion
      $0.total = p.total
      $0.calls = p.calls
      $0.compressions = p.compressions
      $0.contextUsed = p.contextUsed
      $0.contextMax = p.contextMax
      $0.contextPercent = p.contextPercent
      $0.contextSource = p.contextSource
      $0.contextEstimated = p.contextEstimated
      $0.cacheHitPct = p.cacheHitPct
      $0.cacheRead = p.cacheRead
      $0.cacheWrite = p.cacheWrite
      $0.avgLatencyS = p.avgLatencyS
      $0.avgTps = p.avgTps
      $0.activeSubagents = p.activeSubagents
      $0.devCreditsSpentMicros = p.devCreditsSpentMicros
      $0.costUSD = p.costUSD
      $0.costStatus = p.costStatus
    }
  }

  static func reaction(_ p: MessageReaction) -> MessageReaction {
    with(MessageReaction()) { $0.emoji = p.emoji; $0.author = p.author; $0.at = p.at; $0.seen = p.seen }
  }

  static func toolStart(_ p: ToolStartPayload) -> ToolStartPayload {
    with(ToolStartPayload()) {
      $0.toolID = p.toolID
      $0.name = p.name
      $0.context = p.context
      $0.args = p.args
      $0.argsText = p.argsText
      $0.preview = p.preview
      $0.callRowID = p.callRowID
      $0.callIndex = p.callIndex
    }
  }

  static func toolComplete(_ p: ToolCompletePayload) -> ToolCompletePayload {
    with(ToolCompletePayload()) {
      $0.toolID = p.toolID
      $0.name = p.name
      $0.args = p.args
      $0.durationS = p.durationS
      $0.result = p.result
      $0.summary = p.summary
      $0.resultText = p.resultText
      $0.inlineDiff = p.inlineDiff
      $0.todos = p.todos
      $0.revision = p.revision
      $0.error = p.error
      $0.callRowID = p.callRowID
      $0.callIndex = p.callIndex
      $0.rowID = p.rowID
    }
  }

  static func subagent(_ p: SubagentEventPayload) -> SubagentEventPayload {
    with(SubagentEventPayload()) {
      $0.goal = p.goal
      $0.taskCount = p.taskCount
      $0.taskIndex = p.taskIndex
      $0.subagentID = p.subagentID
      $0.parentID = p.parentID
      $0.childSessionID = p.childSessionID
      $0.delegationID = p.delegationID
      $0.depth = p.depth
      $0.model = p.model
      $0.toolCount = p.toolCount
      $0.toolsets = p.toolsets
      $0.inputTokens = p.inputTokens
      $0.outputTokens = p.outputTokens
      $0.reasoningTokens = p.reasoningTokens
      $0.apiCalls = p.apiCalls
      $0.filesRead = p.filesRead
      $0.filesWritten = p.filesWritten
      $0.outputTail = p.outputTail?.map { tail in
        with(SubagentOutputTailEntry()) { $0.tool = tail.tool; $0.preview = tail.preview; $0.isError = tail.isError }
      }
      $0.toolName = p.toolName
      $0.text = p.text
      $0.status = p.status
      $0.summary = p.summary
      $0.durationSeconds = p.durationSeconds
      $0.toolPreview = p.toolPreview
      $0.error = p.error
    }
  }

  static func sideAgent(_ p: SideAgentCompletePayload) -> SideAgentCompletePayload {
    with(SideAgentCompletePayload()) { $0.taskID = p.taskID; $0.text = p.text; $0.question = p.question }
  }

  static func skin(_ p: SkinPayload) -> SkinPayload {
    with(SkinPayload()) {
      $0.name = p.name
      $0.skinDescription = p.skinDescription
      $0.colors = p.colors
      $0.lightColors = p.lightColors
      $0.darkColors = p.darkColors
      $0.branding = p.branding
      $0.bannerLogo = p.bannerLogo
      $0.bannerHero = p.bannerHero
      $0.toolPrefix = p.toolPrefix
      $0.helpHeader = p.helpHeader
    }
  }

  static func info(_ p: SessionLiveInfo) -> SessionLiveInfo {
    with(SessionLiveInfo()) {
      $0.model = p.model
      $0.provider = p.provider
      $0.reasoningEffort = p.reasoningEffort
      $0.serviceTier = p.serviceTier
      $0.fast = p.fast
      $0.yolo = p.yolo
      $0.approvalMode = p.approvalMode
      $0.tools = p.tools
      $0.skills = p.skills
      $0.cwd = p.cwd
      $0.branch = p.branch
      $0.project = p.project
      $0.terminalBackend = p.terminalBackend
      $0.personality = p.personality
      $0.running = p.running
      $0.turnStartedAt = p.turnStartedAt
      $0.title = p.title
      $0.storedSessionID = p.storedSessionID
      $0.desktopContract = p.desktopContract
      $0.version = p.version
      $0.releaseDate = p.releaseDate
      $0.updateBehind = p.updateBehind
      $0.updateCommand = p.updateCommand
      $0.usage = p.usage.map(usage)
      $0.profileName = p.profileName
      $0.mcpServers = p.mcpServers
      $0.systemPrompt = p.systemPrompt
      $0.credentialWarning = p.credentialWarning
      $0.lazy = p.lazy
    }
  }

  static func row(_ p: TranscriptRow) -> TranscriptRow {
    with(TranscriptRow()) {
      $0.role = p.role
      $0.text = p.text
      $0.content = p.content
      $0.displayContent = p.displayContent
      $0.displayKind = p.displayKind
      $0.displayMetadata = p.displayMetadata
      $0.timestamp = p.timestamp
      $0.rowID = p.rowID
      $0.id = p.id
      $0.name = p.name
      $0.context = p.context
      $0.args = p.args
      $0.toolID = p.toolID
      $0.toolCallID = p.toolCallID
      $0.callRowID = p.callRowID
      $0.callIndex = p.callIndex
      $0.reasoning = p.reasoning
      $0.reasoningContent = p.reasoningContent
      $0.reasoningDetails = p.reasoningDetails
      $0.codexMessageItems = p.codexMessageItems
    }
  }

  static func serverRequest(_ request: ServerRequest) -> ServerRequest {
    let body: ServerRequestBody =
      switch request.body {
      case .approval(let p):
        .approval(
          with(ApprovalRequestParams()) {
            $0.sessionID = p.sessionID
            $0.requestID = p.requestID
            $0.command = p.command
            $0.commandDescription = p.commandDescription
            $0.choices = p.choices
            $0.allowPermanent = p.allowPermanent
            $0.allowSession = p.allowSession
            $0.smartDenied = p.smartDenied
            $0.toolName = p.toolName
            $0.gatewaySessionID = p.gatewaySessionID
          })
      case .clarify(let p):
        .clarify(
          with(ClarifyRequestParams()) {
            $0.sessionID = p.sessionID
            $0.question = p.question
            $0.choices = p.choices
            $0.multiSelect = p.multiSelect
            $0.questions = p.questions?.map { q in
              with(ClarifyQuestion()) {
                $0.qid = q.qid
                $0.question = q.question
                $0.choices = q.choices
                $0.multiSelect = q.multiSelect
              }
            }
            $0.answers = p.answers
          })
      case .secret(let p):
        .secret(
          with(SecretRequestParams()) {
            $0.sessionID = p.sessionID
            $0.envVar = p.envVar
            $0.prompt = p.prompt
            $0.metadata = p.metadata
          })
      case .sudo(let p):
        .sudo(
          with(SudoRequestParams()) {
            $0.sessionID = p.sessionID
            $0.command = p.command
          })
      case .vaultUnlock(let p):
        .vaultUnlock(
          with(VaultUnlockRequestParams()) {
            $0.sessionID = p.sessionID
            $0.backend = p.backend
            $0.displayName = p.displayName
          })
      case .vaultCode(let p):
        .vaultCode(
          with(VaultCodeRequestParams()) {
            $0.sessionID = p.sessionID
            $0.site = p.site
            $0.hint = p.hint
          })
      case .vaultSaveLogin(let p):
        .vaultSaveLogin(
          with(VaultSaveLoginRequestParams()) {
            $0.sessionID = p.sessionID
            $0.origin = p.origin
            $0.site = p.site
          })
      case .confirm(let p):
        .confirm(
          with(ConfirmRequestParams()) {
            $0.sessionID = p.sessionID
            $0.title = p.title
            $0.summary = p.summary
            $0.detail = p.detail
            $0.level = p.level
            $0.passkey = p.passkey
          })
      // Typed copies of the interactive requests live in InteractiveContractTests.
      case .inputForm, .inputFile, .reviewDraft, .unknown: request.body
      }
    return ServerRequest(id: request.id ?? "", body)
  }

  static func profileRow(_ p: ProfileRow) -> ProfileRow {
    with(ProfileRow()) {
      $0.name = p.name
      $0.path = p.path
      $0.isDefault = p.isDefault
      $0.model = p.model
      $0.provider = p.provider
      $0.profileDescription = p.profileDescription
      $0.displayName = p.displayName
      $0.skillCount = p.skillCount
      $0.lastSession = p.lastSession
      $0.workerSession = p.workerSession
      $0.canonicalSession = p.canonicalSession.map { c in
        with(ProfileCanonicalSession()) {
          $0.id = c.id
          $0.resolvedID = c.resolvedID
          $0.rootTitle = c.rootTitle
          $0.title = c.title
          $0.preview = c.preview
          $0.startedAt = c.startedAt
          $0.lastActive = c.lastActive
          $0.messageCount = c.messageCount
        }
      }
      $0.uiMetaRevisions = p.uiMetaRevisions
      $0.uiMeta = p.uiMeta
      $0.hasAvatar = p.hasAvatar
    }
  }

  static func profilesList(_ p: ProfilesListResult) -> ProfilesListResult {
    with(ProfilesListResult()) {
      $0.profiles = p.profiles?.map(profileRow)
      $0.botModeProtocol = p.botModeProtocol
    }
  }

  static func resume(_ p: SessionResumeResult) -> SessionResumeResult {
    with(SessionResumeResult()) {
      $0.sessionID = p.sessionID
      $0.storedSessionID = p.storedSessionID
      $0.messageCount = p.messageCount
      $0.messages = p.messages?.map(row)
      $0.info = p.info.map(info)
      $0.resumed = p.resumed
      $0.sessionKey = p.sessionKey
      $0.messagesOmitted = p.messagesOmitted
      $0.hydrating = p.hydrating
      $0.running = p.running
      $0.turnStartedAt = p.turnStartedAt
      $0.startedAt = p.startedAt
      $0.status = p.status
      $0.inflight = p.inflight
      $0.queued = p.queued
      $0.pendingApproval = p.pendingApproval
      $0.openRequests = p.openRequests?.map(serverRequest)
      $0.pendingConnection = p.pendingConnection
      $0.todoState = p.todoState
      $0.autoContinue = p.autoContinue
    }
  }

  static func history(_ p: SessionHistoryResult) -> SessionHistoryResult {
    with(SessionHistoryResult()) { $0.count = p.count; $0.messages = p.messages?.map(row) }
  }

  static func eventsSince(_ p: SessionEventsSinceResult) -> SessionEventsSinceResult {
    with(SessionEventsSinceResult()) {
      $0.events = p.events?.map(event)
      $0.latestSeq = p.latestSeq
      $0.truncated = p.truncated
      $0.count = p.count
      $0.epoch = p.epoch
      $0.openRequests = p.openRequests?.map(serverRequest)
    }
  }

  static func clientCapabilities(_ p: ClientCapabilitiesResult) -> ClientCapabilitiesResult {
    with(ClientCapabilitiesResult(json: [:])) {
      $0.serverRequests = p.serverRequests
      $0.confirm = p.confirm
      $0.confirmPasskey = p.confirmPasskey
      $0.requests = p.requests
    }
  }

  static func promptSubmit(_ p: PromptSubmitResult) -> PromptSubmitResult {
    with(PromptSubmitResult()) {
      $0.status = p.status
      $0.voiceStopped = p.voiceStopped
      $0.survivorUserRowIDs = p.survivorUserRowIDs
      $0.survivorRowIDMap = p.survivorRowIDMap
      $0.turnIsolation = p.turnIsolation
    }
  }

  static func sessionMessages(_ p: SessionMessagesResponse) -> SessionMessagesResponse {
    with(SessionMessagesResponse()) {
      $0.sessionID = p.sessionID
      $0.profile = p.profile
      $0.messages = p.messages?.map(row)
      $0.pagination = p.pagination.map { page in
        with(SessionMessagesPagination()) {
          $0.limit = page.limit
          $0.offset = page.offset
          $0.order = page.order
          $0.returned = page.returned
        }
      }
    }
  }
}

func with<T>(_ value: T, _ change: (inout T) -> Void) -> T {
  var copy = value
  change(&copy)
  return copy
}
