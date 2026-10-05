/**
 * Standing and session approvals, as `approval.grants` / `approval.revoke` list and withdraw them
 * (`tui_gateway/approval_grants.py`, `tui_gateway/methods_prompt.py`, `tui_gateway/contracts/prompt_voice.py`).
 *
 * What the real gateway guarantees and this one keeps:
 *
 *  - **Standing approvals belong to a profile.** `profile` names it (unknown: 4064); without it `session_id`
 *    does, else the launch profile. Each profile has its own list: revoking one bot's grant never touches
 *    another's.
 *  - **Session approvals belong to a live session** and are listed for the live sessions of the profile that
 *    hold a grant or YOLO (the one `session_id` names always). A session that is not live, or one of another
 *    profile than the `profile` asked for, is 4001 like an unknown id.
 *  - **A row is a group of rules.** Its `label` may name several rules joined with `"; "`; the `id` is opaque,
 *    `perm:` / `sess:` plus sixteen hex digits of a hash of the profile and the rules. A revoke recomputes it
 *    against what is stored at that moment: an id that no longer names a grant revokes nothing (`revoked: 0`),
 *    which is an answer and not an error.
 *  - **`revoked` counts the rows removed** here (the real gateway counts stored entries; one row is one entry
 *    for every row this fake can stage).
 *  - `approval.revoke` takes exactly one of `id` or `all` (4006), and `scope: session` needs a `session_id`
 *    (4006). A key a contract does not name is 4000. An agent's connection is refused with 4033 (stage it
 *    through `POST /__fake/deny`, like every other refusal).
 *
 * The control route `POST /__fake/approvals` stages the lists; `GET /__fake/approvals` shows them and every call
 * made. Neither is part of the contract.
 */
import { createHash } from 'node:crypto'

export const APPROVAL_GRANTS_METHODS = ['approval.grants', 'approval.revoke'] as const

/** The keys each method's contract accepts. */
const PARAMS: Record<(typeof APPROVAL_GRANTS_METHODS)[number], readonly string[]> = {
  'approval.grants': ['profile', 'session_id'],
  'approval.revoke': ['scope', 'id', 'all', 'session_id', 'profile']
}

export const APPROVAL_MODES = ['manual', 'smart', 'off'] as const

/** A refusal with the gateway's code; the server turns it into its own `RpcFault`. */
export class ApprovalGrantsError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'ApprovalGrantsError'
  }
}

export interface StoredGrant {
  /** The rules the row names, joined with `"; "` in its label. */
  rules: string[]
  kind: string
  tirith: boolean
}

export interface ApprovalGrantsStage {
  mode: (typeof APPROVAL_MODES)[number]
  /** The standing grants of each profile. */
  permanent: Map<string, StoredGrant[]>
  /** The session grants, by the session's stored id (`session_key`). */
  sessions: Map<string, StoredGrant[]>
  /** The gateway has no approval methods (an older one): `-32601`. */
  unsupported: boolean
  /** Every call, newest last: its method, the profile it named (null for none) and its param keys. */
  calls: { method: string; profile: string | null; keys: string[] }[]
}

export const emptyApprovalGrantsStage = (): ApprovalGrantsStage => ({
  calls: [],
  mode: 'manual',
  permanent: new Map(),
  sessions: new Map(),
  unsupported: false
})

/** What the server tells this module about the live sessions; it owns them. */
export interface LiveSession {
  /** The runtime id. */
  id: string
  /** The stored id, which is the `session_key`. */
  storedId: string
  profile: string
  yolo: boolean
}

const digest = (prefix: string, profile: string, rules: string[]): string =>
  `${prefix}:${createHash('sha256')
    .update(`${profile}\0${[...rules].sort().join('\n')}`)
    .digest('hex')
    .slice(0, 16)}`

const label = (rules: string[]): string => [...rules].sort().join('; ')

const standingRow = (profile: string, grant: StoredGrant) => ({
  id: digest('perm', profile, grant.rules),
  kind: grant.kind,
  label: label(grant.rules)
})

const sessionRow = (profile: string, grant: StoredGrant) => ({
  id: digest('sess', profile, grant.rules),
  kind: 'pattern' as const,
  label: label(grant.rules),
  tirith: grant.tirith
})

/** A grant as a test stages it: a `label` of one rule, or several joined with `"; "`. */
export const stagedGrant = (row: Record<string, unknown>): StoredGrant => {
  const text = typeof row.label === 'string' ? row.label : ''
  const rules = text
    .split('; ')
    .map(part => part.trim())
    .filter(Boolean)

  const kind = typeof row.kind === 'string' && ['pattern', 'command', 'glob'].includes(row.kind) ? row.kind : 'pattern'

  return { kind, rules: rules.length ? rules : ['unnamed rule'], tirith: row.tirith === true }
}

const requireKeys = (method: (typeof APPROVAL_GRANTS_METHODS)[number], params: Record<string, unknown>): void => {
  const unknown = Object.keys(params).find(key => !PARAMS[method].includes(key))

  if (unknown) {
    throw new ApprovalGrantsError(
      4000,
      `invalid params for ${method}: ${unknown}: Extra inputs are not permitted — the client and the Hermes backend are out of sync (different versions); run \`hermes update\` and restart both`
    )
  }
}

/** The live session `session_id` names, or 4001. `profile` (when given) must be its profile. */
const named = (live: LiveSession[], params: Record<string, unknown>, profile: string | null): LiveSession | null => {
  const id = typeof params.session_id === 'string' ? params.session_id : ''

  if (!id) {
    return null
  }

  const session = live.find(entry => entry.id === id)

  if (!session || (profile && session.profile !== profile)) {
    throw new ApprovalGrantsError(4001, 'session not found')
  }

  return session
}

/**
 * One `approval.*` call. `profile` is the one the call named (null for none) and is already known to be a
 * profile the gateway serves (else the server answered 4064); `launch` is the launch profile's name.
 */
export const approvalCall = (
  stage: ApprovalGrantsStage,
  method: string,
  params: Record<string, unknown>,
  profile: string | null,
  launch: string,
  live: LiveSession[]
): unknown => {
  stage.calls.push({ keys: Object.keys(params).sort(), method, profile })

  if (stage.unsupported) {
    throw new ApprovalGrantsError(-32601, `unknown method: ${method}`)
  }

  const known = method as (typeof APPROVAL_GRANTS_METHODS)[number]
  requireKeys(known, params)

  if (known === 'approval.grants') {
    const session = named(live, params, profile)
    const owner = profile ?? session?.profile ?? launch
    const candidates = session ? [session] : live.filter(entry => entry.profile === owner)

    const sessions = candidates
      .map(entry => ({
        grants: (stage.sessions.get(entry.storedId) ?? []).map(grant => sessionRow(entry.profile, grant)),
        session_id: entry.id,
        session_key: entry.storedId,
        yolo: entry.yolo
      }))
      .filter(row => session || row.grants.length > 0 || row.yolo)

    return {
      mode: stage.mode,
      permanent: (stage.permanent.get(owner) ?? []).map(grant => standingRow(owner, grant)),
      sessions
    }
  }

  const id = typeof params.id === 'string' && params.id ? params.id : null
  const all = params.all === true

  if (Boolean(id) === all) {
    throw new ApprovalGrantsError(4006, 'send exactly one of id or all')
  }

  if (params.scope !== 'permanent' && params.scope !== 'session') {
    throw new ApprovalGrantsError(4006, 'scope must be permanent or session')
  }

  if (params.scope === 'session' && !params.session_id) {
    throw new ApprovalGrantsError(4006, 'session_id required for scope session')
  }

  const session = named(live, params, profile)

  if (params.scope === 'session' && session) {
    const stored = stage.sessions.get(session.storedId) ?? []
    const kept = id ? stored.filter(grant => digest('sess', session.profile, grant.rules) !== id) : []
    stage.sessions.set(session.storedId, kept)

    return { revoked: stored.length - kept.length }
  }

  const owner = profile ?? session?.profile ?? launch
  const stored = stage.permanent.get(owner) ?? []
  const kept = id ? stored.filter(grant => digest('perm', owner, grant.rules) !== id) : []
  stage.permanent.set(owner, kept)

  return { revoked: stored.length - kept.length }
}

/** What `GET /__fake/approvals` shows: the mode, both lists with their rules, and every call. */
export const approvalView = (stage: ApprovalGrantsStage) => ({
  calls: stage.calls,
  mode: stage.mode,
  permanent: Object.fromEntries(
    [...stage.permanent].map(([profile, grants]) => [profile, grants.map(g => label(g.rules))])
  ),
  sessions: Object.fromEntries([...stage.sessions].map(([key, grants]) => [key, grants.map(g => label(g.rules))])),
  unsupported: stage.unsupported
})
