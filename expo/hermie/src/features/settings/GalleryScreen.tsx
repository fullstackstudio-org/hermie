/**
 * The developer gallery: every chat component with realistic data, on one
 * screen, on every platform.
 *
 * It exists because the chat kit is built ahead of the data layer. Without it
 * the only way to look at a tool card, a forwarded DM or the approval sheet
 * would be to drive a real gateway into the exact state that produces one — and
 * some of those states (a failed delivery, an untrusted-output banner) are hard
 * to produce on purpose.
 *
 * **Every section is ADDRESSABLE.** The list below is a registry keyed by id,
 * and `--hermieOpen gallery:<id>` renders exactly one of them, alone, filling
 * the screen (`src/dev/launch-intent.ts`). That is not a convenience: the
 * simulators on this machine can be launched and photographed and nothing else,
 * so a surface that is only reachable by tapping is a surface nobody has ever
 * looked at. One launch, one screenshot. A section whose `sheet` field names a
 * sheet opens that sheet as it mounts, which is how a blocking modal and an
 * options page become photographable at all.
 *
 * The streaming section appends to a real reply on an interval, so the
 * incremental Markdown path is exercised the way a live turn exercises it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'

import {
  AgentsBar,
  AgentsSheet,
  AssistantBubble,
  AttachMenu,
  BotDmAside,
  BotDmRollup,
  ChatHeader,
  Composer,
  CronDeliveryCard,
  DateSeparator,
  DiffView,
  ErrorCard,
  ExpandedProvider,
  FileChip,
  JumpToLatestPill,
  NoticePill,
  QueuedChip,
  ReasoningDisclosure,
  StatusRow,
  SubagentGroupCard,
  ToolCard,
  TranscriptList,
  TypingIndicator,
  UserBubble
} from '../../chat-ui'
import {
  approvalItem,
  assistantItem,
  assistantMarkdown,
  botDmInItem,
  botDmOutItem,
  clarifyItem,
  cronDeliveryItem,
  dmRunItems,
  errorAssistantItem,
  failedDmOutItem,
  failedToolItem,
  foldTableStraddleItem,
  galleryTranscript,
  inlineCodeRegressionItem,
  interimAssistantItem,
  longReportItem,
  noticeItem,
  overflowItem,
  pendingTurnTranscript,
  patchToolItem,
  pendingDmOutItem,
  processNoticeItem,
  recoverableAssistantItem,
  runningToolItem,
  sampleDiff,
  searchToolItem,
  statusItem,
  subagentGroupItem,
  subagentMap,
  subagentTree,
  sampleAttachmentUri,
  userItem,
  userItemWithImages,
  userItemWithMixedAttachments
} from '../../chat-ui/fixtures'
import type { ApprovalItem, ClarifyItem, PickerOption, Verbosity } from '../../chat-ui/types'
import { ConnectionLine } from '../bots/ConnectionLine'
import {
  CronDetailScreen,
  CronEditorSheet,
  CronRunScreen,
  cronJobFromRow,
  cronRunFromRow,
  ScheduleBuilder,
  StatusDot,
  DEFAULT_SCHEDULE_DRAFT,
  type CronJob,
  type ScheduleDraft
} from '../cron'
import { GatewayStoppedPanel } from '../../gateway/GatewayStoppedPanel'
import {
  DoneStep,
  emptyDraft,
  GatewayAddressStep,
  OnboardingCard,
  SignInStep,
  StatusLine,
  TestConnectionStep,
  WelcomeStep,
  type OnboardingDraft
} from '../onboarding'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { Button, InsetButtonRow, InsetGroup, Screen, Text } from '../../ui/primitives'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { DM_LINE_GAP, type AccentName } from '../../ui/tokens'
import { AppearanceSection } from './AppearanceSection'

export interface GalleryScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
  /**
   * Render only this section. Unknown ids fall back to the whole gallery, so a
   * typo in a launch argument produces a screenshot of something rather than a
   * blank screen with no clue in it.
   */
  section?: string
}

/** The Settings row that opens this screen; kept here so the two cannot drift. */
export const GALLERY_ROW_TITLE = 'Component gallery'

const STREAM_INTERVAL_MS = 120
const STREAM_CHUNK = 24

/**
 * Onboarding drafts, one per state the wizard can be in.
 *
 * The wizard is the one screen nobody can reach twice: once a gateway is
 * configured it never shows again, and the states that matter most — a probe
 * that failed, a gateway too old for native sign-in — need a gateway that is
 * broken in a particular way. So every step is addressable here with a draft
 * that puts it in that state, and no network is touched: a draft carrying a
 * `probe` needs no probe to have run.
 */
const GATED_PROBE = {
  authFlows: ['cookie', 'native_pkce'],
  authRequired: true,
  providers: [{ displayName: 'Self-Hosted OIDC', name: 'self-hosted', supportsPassword: false }],
  supportsNativePkce: true,
  version: '2026.9.14'
}

const ONBOARDING_DRAFTS: Record<string, OnboardingDraft> = {
  gated: {
    ...emptyDraft(),
    baseUrl: 'https://hermes.example.com',
    probe: GATED_PROBE,
    provider: GATED_PROBE.providers[0] ?? null,
    rawAddress: 'hermes.example.com'
  },
  token: {
    ...emptyDraft(),
    baseUrl: 'http://gateway.example.com:9119',
    probe: { ...GATED_PROBE, authRequired: false, providers: [], supportsNativePkce: false },
    rawAddress: 'gateway.example.com:9119'
  },
  tooOld: {
    ...emptyDraft(),
    baseUrl: 'https://hermes.example.net',
    probe: { ...GATED_PROBE, authFlows: ['cookie'], supportsNativePkce: false },
    rawAddress: 'hermes.example.net'
  }
}

function signedIn(draft: OnboardingDraft): OnboardingDraft {
  return {
    ...draft,
    tokens: {
      accessToken: 'access',
      expiresAt: 4_102_444_800,
      provider: 'self-hosted',
      refreshToken: 'refresh',
      userId: 'tester@example.invalid'
    }
  }
}

/** A step in its card, with the actions wired to nothing. */
function OnboardingState({
  children,
  cover = false,
  lead,
  gated = false,
  primaryLabel = 'Continue',
  say,
  stepIndex,
  title
}: {
  children?: ReactNode
  cover?: boolean
  lead: string
  /** The step has not produced what Continue needs yet, so Continue is shut. */
  gated?: boolean
  primaryLabel?: string
  say: (message: string) => void
  stepIndex: number
  title: string
}) {
  return (
    <OnboardingCard
      cover={cover}
      lead={lead}
      onBack={cover ? undefined : () => say('Onboarding: back')}
      onPrimary={() => say(`Onboarding: ${primaryLabel}`)}
      primaryDisabled={gated}
      primaryLabel={primaryLabel}
      stepCount={4}
      stepIndex={stepIndex}
      title={title}
    >
      {children}
    </OnboardingCard>
  )
}

const REASONING_OPTIONS: PickerOption[] = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' }
]

const SLASH_SUGGESTIONS = [
  { description: 'Compact the conversation', name: 'compact' },
  { description: 'Show the current model', name: 'model' },
  { description: 'Reset this chat', name: 'reset' }
]

const MODEL_OPTIONS: PickerOption[] = [
  { detail: 'Whatever the gateway is configured for', label: 'Gateway default', value: 'default' },
  { detail: 'Runs on the gateway host', label: 'example-model-local', value: 'example-model-local' },
  { detail: 'Long context', expensive: true, label: 'example-model-large', value: 'example-model-large' }
]

// ── cron fixtures ────────────────────────────────────────────────────────────
// Built through the same row projections the gateway's answers go through, so a
// change to either one breaks the gallery rather than letting it drift into
// showing a shape the app no longer produces.

const CRON_JOB: CronJob = cronJobFromRow({
  job_id: 'job-scout',
  name: 'Nightly domain scout',
  schedule: 'every day at 04:22',
  prompt: 'Check the watch list for newly available domains and summarise anything worth acting on.',
  prompt_preview: 'Check the watch list for newly available domains…',
  deliver: 'researcher',
  enabled: true,
  state: 'active',
  next_run_at: new Date(Date.now() + 9_000_000).toISOString(),
  last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
  last_status: 'ok',
  profile: 'researcher'
})

const CRON_JOB_FAILED: CronJob = cronJobFromRow({
  job_id: 'job-books',
  name: 'Reconcile the ledger',
  schedule: 'every Monday at 09:00',
  prompt_preview: 'Pull yesterday’s transactions and reconcile.',
  deliver: 'bookkeeper',
  enabled: false,
  state: 'paused',
  paused_reason: 'Paused after three failures',
  next_run_at: null,
  last_run_at: new Date(Date.now() - 86_400_000).toISOString(),
  last_status: 'failed',
  last_error: 'The gateway refused the delivery target.',
  profile: 'bookkeeper'
})

const CRON_RUN = cronRunFromRow({
  session_id: 'run-4412',
  started_at: Math.floor(Date.now() / 1000) - 3_600,
  ended_at: Math.floor(Date.now() / 1000) - 3_540,
  status: 'ok',
  message_count: 6,
  preview: '## Nightly domain scout\n\n- 2 domains dropped overnight',
  title: 'Nightly domain scout'
})

const CRON_TARGETS = [
  { id: 'local', name: 'Keep it in the routine', homeTargetSet: false },
  { id: 'researcher', name: 'Researcher', homeTargetSet: true },
  { id: 'writer', name: 'Writer', homeTargetSet: false }
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm }}>
      <Text color="textFaint" variant="micro">
        {title.toUpperCase()}
      </Text>
      <View
        style={{
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.card,
          borderWidth: 1,
          gap: theme.space.sm,
          padding: theme.space.md
        }}
      >
        {children}
      </View>
    </View>
  )
}

/**
 * The simulated turn, in its own component on purpose.
 *
 * The timer fires several times a second; if the state lived on the gallery,
 * every tick would re-render every other section — four tool cards, a diff, a
 * table — and the screen would stop scrolling. Isolating the state is the same
 * discipline a real chat needs, which makes it the right thing to demonstrate.
 */
function StreamingBody() {
  const [streaming, setStreaming] = useState(true)
  const [length, setLength] = useState(0)

  useEffect(() => {
    if (!streaming) {
      return
    }

    const timer = setInterval(() => {
      setLength(current =>
        current >= assistantMarkdown.length ? 0 : Math.min(assistantMarkdown.length, current + STREAM_CHUNK)
      )
    }, STREAM_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [streaming])

  const text = assistantMarkdown.slice(0, length)

  const item = useMemo(
    () => ({ ...assistantItem, id: 'a-live', reasoning: undefined, streaming: true, text, version: text.length }),
    [text]
  )

  return (
    <>
      {/* Fixed height: the reply grows and resets several times a second, and a
          section that changes height would shove the whole gallery around
          under the reader's finger. */}
      <View style={{ height: 320, overflow: 'hidden' }}>
        <AssistantBubble item={item} presentation="full" />
      </View>
      <Button
        onPress={() => setStreaming(current => !current)}
        title={streaming ? 'Pause stream' : 'Resume stream'}
        variant="secondary"
      />
    </>
  )
}

/** A schedule builder with its own draft, so the section is self-contained. */
function ScheduleBuilderBody() {
  const [draft, setDraft] = useState<ScheduleDraft>(DEFAULT_SCHEDULE_DRAFT)

  return <ScheduleBuilder draft={draft} onChange={setDraft} />
}

/** Which sheet a section wants open the moment it mounts. */
type SheetName = 'agents' | 'approval' | 'approvalAnswered' | 'clarify' | 'options' | 'cronEditor'

type OptionsPane = 'reasoning' | 'model' | 'colour' | 'mute'

interface GalleryContext {
  theme: ReturnType<typeof useTheme>
  lastAction: string
  say: (action: string) => void
  draft: string
  setDraft: (value: string) => void
  running: boolean
  setRunning: (value: boolean) => void
  cronExpanded: boolean
  toggleCron: () => void
  openSheet: (sheet: SheetName, pane?: OptionsPane) => void
  openChatDemo: () => void
}

interface GallerySection {
  id: string
  title: string
  /** Opens a sheet as the section mounts. */
  sheet?: SheetName
  /** Which page of the options sheet, for the paged sections. */
  pane?: OptionsPane
  /**
   * The section owns the whole screen instead of sitting in a bordered card —
   * anything with its own header, list and footer.
   */
  full?: boolean
  /**
   * The section reads `useGateway()`, so it is addressable but is NOT part of the
   * scrolling gallery.
   *
   * The scrolling gallery is rendered bare in component tests and has no
   * provider above it; the addressable route always does, because it lands inside
   * `GatewayProvider` in `App.tsx`. One crashing section would take the whole
   * gallery with it, which is worse than reaching these two by name.
   */
  needsGateway?: boolean
  render: (ctx: GalleryContext) => ReactNode
}

/**
 * Every addressable surface, in the order the gallery scrolls.
 *
 * Adding a component to the kit means adding a row here, which is what keeps
 * "one launch = one screenshot" true for the NEXT component rather than only for
 * the ones that happened to be built when this was written.
 */
const SECTIONS: readonly GallerySection[] = [
  {
    id: 'chat-header',
    title: 'Chat header',
    render: ctx => (
      <>
        <ChatHeader
          name="researcher"
          secondaryName="Researcher"
          onOpenOptions={() => ctx.openSheet('options')}
          presence="working"
          testID="gallery-chat-header"
        />
        <ChatHeader
          lastSeenAt={1_767_000_000}
          name="writer"
          secondaryName="Writer"
          onOpenOptions={() => ctx.openSheet('options')}
          presence="offline"
          testID="gallery-chat-header-offline"
        />
        <ChatHeader
          name="bookkeeper"
          secondaryName="Bookkeeper"
          onOpenOptions={() => ctx.openSheet('options')}
          presence="needsInput"
          testID="gallery-chat-header-needs-input"
        />
        <ChatHeader
          name="postman"
          secondaryName="Postman"
          onOpenOptions={() => ctx.openSheet('options')}
          presence="online"
          testID="gallery-chat-header-online"
        />
      </>
    )
  },
  {
    id: 'agents-bar',
    title: 'Agents bar',
    render: ctx => (
      <AgentsBar count={3} elapsedSeconds={72} onPress={() => ctx.openSheet('agents')} testID="gallery-agents-bar" />
    )
  },
  { id: 'streaming', title: 'Streaming reply', render: () => <StreamingBody /> },
  {
    id: 'attachments',
    title: 'Attachments',
    render: ctx => (
      <>
        {/* A picture the app can load is a card; one it cannot stays a chip,
            which is what every attachment older than this session looks like. */}
        <UserBubble
          attachmentUri={sampleAttachmentUri}
          item={userItemWithImages}
          onOpenAttachment={entry => ctx.say(`Open ${entry.name}`)}
          tail={false}
        />
        <UserBubble
          attachmentUri={sampleAttachmentUri}
          item={userItemWithMixedAttachments}
          onOpenAttachment={entry => ctx.say(`Open ${entry.name}`)}
          receipt="read"
          tail
        />
        <UserBubble item={userItemWithImages} tail />
      </>
    )
  },
  {
    id: 'bubbles',
    title: 'Bubbles',
    render: () => (
      <>
        <DateSeparator label="Yesterday" />
        {/* Grouping: three own bubbles in a run, only the last with a tail. */}
        <UserBubble grouped={false} item={userItem} tail={false} />
        <UserBubble grouped item={{ ...userItem, id: 'u1b', text: 'And keep it short.' }} tail={false} />
        <UserBubble grouped item={{ ...userItem, id: 'u1c', text: 'Thanks.' }} receipt="read" tail />
        <AssistantBubble item={assistantItem} presentation="full" showFooter />
        <AssistantBubble item={interimAssistantItem} presentation="full" />
        <TypingIndicator />
      </>
    )
  },
  {
    id: 'receipts',
    title: 'Receipts',
    render: () => (
      <>
        <UserBubble item={{ ...userItem, id: 'u-r1', text: 'Sending.' }} receipt="sending" />
        <UserBubble item={{ ...userItem, id: 'u-r2', text: 'Sent.' }} receipt="sent" />
        <UserBubble item={{ ...userItem, id: 'u-r3', text: 'Delivered.' }} receipt="delivered" />
        <UserBubble item={{ ...userItem, id: 'u-r4', text: 'Read.' }} receipt="read" />
      </>
    )
  },
  {
    id: 'long-reply',
    title: 'Long reply — reading treatment and fold',
    render: () => (
      // The fold's state lives above the list, so the gallery provides one.
      <ExpandedProvider>
        <AssistantBubble item={longReportItem} presentation="full" showFooter />
      </ExpandedProvider>
    )
  },
  {
    id: 'fold-table',
    title: 'Fold — a table across the cut',
    render: () => (
      // The fold moves its cut UP to the table's top rather than slicing a row
      // of cells in half. Only a rendered bubble can show whether it did.
      <ExpandedProvider>
        <AssistantBubble item={foldTableStraddleItem} presentation="full" />
      </ExpandedProvider>
    )
  },
  {
    id: 'markdown-overflow',
    title: 'Markdown — wider than the bubble',
    render: () => (
      // The owner's photograph: a table cut off mid-word at the bubble's right
      // edge. A fenced one-liner and an unbreakable path ride along, because a
      // table is only one of the three shapes that cannot wrap narrower.
      <ExpandedProvider>
        <AssistantBubble item={overflowItem} presentation="full" />
      </ExpandedProvider>
    )
  },
  {
    id: 'markdown-regressions',
    title: 'Markdown regressions',
    render: () => (
      // The exact sentence the owner hit: a code span near a line end, and
      // emphasis a model opened with a stray space.
      <ExpandedProvider>
        <AssistantBubble item={inlineCodeRegressionItem} presentation="full" />
      </ExpandedProvider>
    )
  },
  {
    id: 'cron-card',
    title: 'Cron delivery card',
    render: ctx => (
      <CronDeliveryCard
        body={cronDeliveryItem.body}
        expanded={ctx.cronExpanded}
        name={cronDeliveryItem.jobName}
        onOpenCron={() => ctx.say('Open cron')}
        onRunNow={() => ctx.say('Run cron now')}
        onToggle={ctx.toggleCron}
        testID="gallery-cron-card"
        ts={cronDeliveryItem.ts}
      />
    )
  },
  {
    id: 'cron-card-actionless',
    title: 'Cron delivery card — no actions resolvable',
    render: ctx => (
      <CronDeliveryCard
        body={cronDeliveryItem.body}
        expanded
        name={cronDeliveryItem.jobName}
        onToggle={ctx.toggleCron}
        testID="gallery-cron-card-actionless"
        ts={cronDeliveryItem.ts}
      />
    )
  },
  {
    id: 'errors',
    title: 'Errors',
    render: ctx => (
      <>
        <AssistantBubble item={errorAssistantItem} onRetry={() => ctx.say('Retry pressed')} />
        <AssistantBubble item={recoverableAssistantItem} />
        <ErrorCard message="The gateway is unreachable." onRetry={() => ctx.say('Retry')} retryable />
      </>
    )
  },
  {
    id: 'reasoning',
    title: 'Reasoning',
    render: () => (
      <ReasoningDisclosure durationS={4} text="Compare the changelog with the docs, then hand off to Writer." />
    )
  },
  {
    id: 'tool-cards',
    title: 'Tool cards',
    render: () => (
      <ExpandedProvider>
        <ToolCard item={searchToolItem} presentation="collapsed" />
        <ToolCard item={patchToolItem} presentation="full" />
        <ToolCard item={failedToolItem} presentation="collapsed" />
        <ToolCard item={runningToolItem} presentation="collapsed" />
      </ExpandedProvider>
    )
  },
  { id: 'diff', title: 'Diff', render: () => <DiffView diff={sampleDiff} /> },
  {
    id: 'dm-lines',
    title: 'Bot-to-bot asides',
    render: ctx => (
      <ExpandedProvider>
        <View style={{ gap: DM_LINE_GAP }}>
          <BotDmAside
            item={botDmOutItem}
            onOpenBot={handle => ctx.say(`Open bot @${handle}`)}
            presentation="collapsed"
          />
          <BotDmAside item={pendingDmOutItem} presentation="collapsed" />
          <BotDmAside item={failedDmOutItem} presentation="collapsed" />
          <BotDmAside
            answered
            item={botDmInItem}
            onOpenBot={handle => ctx.say(`Open bot @${handle}`)}
            presentation="collapsed"
          />
        </View>
      </ExpandedProvider>
    )
  },
  {
    id: 'dm-rollup',
    title: 'Bot-to-bot roll-up',
    render: () => (
      <ExpandedProvider>
        <BotDmRollup run={{ handle: 'writer', id: dmRunItems[0]?.id ?? 'dm-run-0', items: dmRunItems, replies: 4 }} />
      </ExpandedProvider>
    )
  },
  {
    id: 'agents-group',
    title: 'Agents',
    render: ctx => (
      <SubagentGroupCard
        item={subagentGroupItem}
        onOpenTranscript={id => ctx.say(`Open transcript ${id}`)}
        presentation="full"
        subagents={[subagentMap['sa-1']!, subagentMap['sa-2']!, subagentMap['sa-3']!]}
      />
    )
  },
  {
    id: 'rows-pills',
    title: 'Rows and pills',
    render: ctx => (
      <>
        <StatusRow item={statusItem} presentation="chip" />
        <NoticePill item={noticeItem} presentation="collapsed" />
        <NoticePill item={processNoticeItem} presentation="full" />
        <QueuedChip text="Include source links" />
        <JumpToLatestPill count={3} onPress={() => ctx.say('Jump to latest')} />
      </>
    )
  },
  {
    id: 'file-chips',
    title: 'File chips',
    render: ctx => (
      <View style={{ alignItems: 'flex-start', gap: ctx.theme.space.sm }}>
        <FileChip name="quarterly-report-final-v4.xlsx" onRemove={() => ctx.say('Remove chip')} size={48210} />
        <FileChip name="archive.zip" progress={0.4} size={98_000_000} status="uploading" />
        <FileChip error="Too large · 100 MB max" name="capture.mov" size={420_000_000} status="error" />
        <FileChip name="notes.md" onAccent size={1240} />
      </View>
    )
  },
  {
    id: 'attach-menu',
    title: 'Attach menu',
    render: ctx => (
      <AttachMenu
        choices={[
          { id: 'photo', label: 'Photo library' },
          { busy: true, id: 'file', label: 'Choose file' }
        ]}
        onChoose={id => ctx.say(`Attach ${id}`)}
        testID="gallery-attach-menu"
      />
    )
  },
  {
    id: 'composer',
    title: 'Composer',
    render: ctx => (
      <Composer
        attachments={[
          { id: 'att-1', kind: 'image', name: 'diagram.png' },
          { id: 'att-2', kind: 'file', name: 'quarterly-report-final-v4.xlsx', size: 48210, status: 'uploaded' },
          { error: 'Too large · 100 MB max', id: 'att-3', kind: 'file', name: 'capture.mov', status: 'error' }
        ]}
        botName="Researcher"
        onAttach={() => ctx.say('Attach pressed')}
        onChangeText={ctx.setDraft}
        onRemoveAttachment={id => ctx.say(`Remove ${id}`)}
        onSend={text => {
          ctx.say(`Sent: ${text}`)
          ctx.setDraft('')
          ctx.setRunning(true)
        }}
        onStop={() => {
          ctx.setRunning(false)
          ctx.say('Stopped')
        }}
        queuedText="Include source links"
        running={ctx.running}
        suggestions={SLASH_SUGGESTIONS}
        value={ctx.draft}
      />
    )
  },
  {
    id: 'connection-line',
    title: 'Connection line — every state',
    needsGateway: true,
    render: () => (
      <>
        {/* `ready` deliberately renders nothing: a row that only ever says
            "Connected" is a row nobody reads (tokens §1.6). */}
        <ConnectionLine status="ready" />
        <ConnectionLine status="connecting" />
        <ConnectionLine status="reconnecting" />
        <ConnectionLine status="offline" />
        <ConnectionLine status="needs_signin" />
      </>
    )
  },
  {
    id: 'signed-out',
    title: 'Stopped gateway panel',
    full: true,
    needsGateway: true,
    render: () => <GatewayStoppedPanel />
  },
  {
    id: 'cron-status-dots',
    title: 'Cron status dots',
    render: ctx => (
      <View style={{ flexDirection: 'row', gap: ctx.theme.space.lg }}>
        <StatusDot status="ok" />
        <StatusDot status="failed" />
        <StatusDot status="paused" />
        <StatusDot status="pending" />
      </View>
    )
  },
  { id: 'cron-schedule-builder', title: 'Cron schedule builder', render: () => <ScheduleBuilderBody /> },
  {
    id: 'cron-detail',
    title: 'Cron detail',
    full: true,
    render: ctx => (
      <CronDetailScreen
        controller={null}
        job={CRON_JOB}
        onClose={() => ctx.say('Close cron detail')}
        onDeleted={() => ctx.say('Cron deleted')}
        onEdit={() => ctx.openSheet('cronEditor')}
        onOpenRun={() => ctx.say('Open run')}
      />
    )
  },
  {
    id: 'cron-detail-paused',
    title: 'Cron detail — paused and failing',
    full: true,
    render: ctx => (
      <CronDetailScreen
        controller={null}
        job={CRON_JOB_FAILED}
        onClose={() => ctx.say('Close cron detail')}
        onDeleted={() => ctx.say('Cron deleted')}
        onEdit={() => ctx.openSheet('cronEditor')}
        onOpenRun={() => ctx.say('Open run')}
      />
    )
  },
  {
    id: 'cron-run',
    title: 'Cron run transcript',
    full: true,
    render: ctx => (
      <CronRunScreen controller={null} job={CRON_JOB} onClose={() => ctx.say('Close run')} run={CRON_RUN} />
    )
  },
  {
    id: 'sheets',
    title: 'Sheets',
    render: ctx => (
      <InsetGroup>
        <InsetButtonRow onPress={() => ctx.openSheet('approval')} title="Open approval sheet" />
        <InsetButtonRow onPress={() => ctx.openSheet('clarify')} title="Open clarify sheet" />
        <InsetButtonRow onPress={() => ctx.openSheet('options')} title="Open chat options" />
        <InsetButtonRow onPress={() => ctx.openSheet('agents')} title="Open agents sheet" />
        <InsetButtonRow onPress={() => ctx.openSheet('cronEditor')} title="Open the cron editor" />
        <InsetButtonRow onPress={ctx.openChatDemo} title="Open the full chat screen" />
      </InsetGroup>
    )
  },
  { id: 'sheet-approval', title: 'Approval sheet', sheet: 'approval', render: () => null },
  {
    id: 'sheet-approval-answered',
    title: 'Approval sheet — answered elsewhere',
    sheet: 'approvalAnswered',
    render: () => null
  },
  {
    /*
      Settings → Appearance, mounted alone.

      It is the REAL section, not a drawing of one: `AppearanceSection` is the
      component `SettingsScreen` renders, so what is photographed here is what a
      reader gets. It exists as a section because Appearance sits four groups
      down a scrolling screen, and a simulator this machine can only launch
      cannot scroll to it.
    */
    id: 'appearance',
    title: 'Settings — Appearance',
    render: () => <AppearanceSection onOpenAdvanced={() => undefined} />
  },
  { id: 'sheet-clarify', title: 'Clarify sheet', sheet: 'clarify', render: () => null },
  { id: 'sheet-agents', title: 'Agents sheet', sheet: 'agents', render: () => null },
  { id: 'sheet-options', title: 'Chat options sheet', sheet: 'options', render: () => null },
  {
    id: 'sheet-options-model-page',
    title: 'Chat options — model page',
    sheet: 'options',
    pane: 'model',
    render: () => null
  },
  {
    id: 'sheet-options-reasoning-page',
    title: 'Chat options — reasoning page',
    sheet: 'options',
    pane: 'reasoning',
    render: () => null
  },
  {
    id: 'sheet-options-colour-page',
    title: 'Chat options — colour picker',
    sheet: 'options',
    pane: 'colour',
    render: () => null
  },
  { id: 'sheet-cron-editor', title: 'Cron editor sheet', sheet: 'cronEditor', render: () => null },

  {
    id: 'typing-after-own',
    title: 'Pending turn after own message',
    full: true,
    render: ctx => (
      // Typing is forced on rather than driven by the composer, so `simctl`
      // needs no tap to reach the state the owner actually reported.
      <Screen edgeToEdgeTop={false} padded={false} testID="gallery-typing-after-own">
        <ChatHeader name="researcher" onOpenOptions={() => ctx.say('Options')} presence="working" />
        <TranscriptList
          items={pendingTurnTranscript}
          onOpenBot={handle => ctx.say(`Open bot @${handle}`)}
          onOpenRequest={() => ctx.say('Open request')}
          onOpenTranscript={id => ctx.say(`Open transcript ${id}`)}
          onRetry={id => ctx.say(`Retry ${id}`)}
          receipt="delivered"
          testID="gallery-typing-after-own-list"
          typing
        />
        <Composer
          botName="Researcher"
          keyboardAvoiding
          onChangeText={ctx.setDraft}
          onSend={text => ctx.say(`Sent: ${text}`)}
          running
          value={ctx.draft}
        />
      </Screen>
    )
  },

  // The onboarding wizard, step by step. `full` throughout: the card draws its
  // own wallpaper and centres itself, which a bordered gallery box would
  // defeat — and the centring is most of what the redesign changed.
  {
    id: 'onboarding-welcome',
    title: 'Onboarding — welcome',
    full: true,
    render: ctx => (
      <OnboardingState
        cover
        lead="Hermie is a client for Hermes Agent. It talks to one gateway at a time — the machine running `hermes serve` — and chats with the bots that live there."
        primaryLabel="Set up a gateway"
        say={ctx.say}
        stepIndex={-1}
        title="Welcome to Hermie"
      >
        <WelcomeStep />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-address',
    title: 'Onboarding — gateway address (empty)',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="The address you would open in a browser to reach the gateway dashboard."
        say={ctx.say}
        stepIndex={0}
        title="Gateway address"
      >
        {/* An empty address fires no probe, so this state needs no gateway. */}
        <GatewayAddressStep draft={emptyDraft()} update={() => {}} />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-address-states',
    title: 'Onboarding — address status lines',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="Every answer the probe can give, so the error copy is readable without breaking a gateway first."
        say={ctx.say}
        stepIndex={0}
        title="Gateway address"
      >
        <StatusLine tone="checking">Checking https://, then http://…</StatusLine>
        <StatusLine tone="ok">
          Hermes 2026.9.14 · sign-in required via Self-Hosted OIDC · Found over https://
        </StatusLine>
        <StatusLine tone="ok">Hermes 2026.9.14 · session token required · Found over http://</StatusLine>
        <StatusLine tone="error">
          Nothing answered at https://hermes.example.com. Check the address, and that the gateway is running.
        </StatusLine>
        <StatusLine tone="error">
          Hermes 2026.9.14 · sign-in required, but this gateway lists no identity providers. Configure one on the
          gateway.
        </StatusLine>
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-signin',
    title: 'Onboarding — sign in (provider)',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device."
        say={ctx.say}
        stepIndex={1}
        title="Sign in"
      >
        <SignInStep draft={ONBOARDING_DRAFTS.gated ?? emptyDraft()} update={() => {}} />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-signin-done',
    title: 'Onboarding — sign in (signed in)',
    full: true,
    render: ctx => (
      <OnboardingState
        lead="The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device."
        say={ctx.say}
        stepIndex={1}
        title="Sign in"
      >
        <SignInStep draft={signedIn(ONBOARDING_DRAFTS.gated ?? emptyDraft())} update={() => {}} />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-signin-token',
    title: 'Onboarding — sign in (session token)',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="This gateway is not gated by an identity provider; it authenticates with the session token it prints at startup."
        say={ctx.say}
        stepIndex={1}
        title="Sign in"
      >
        <SignInStep draft={ONBOARDING_DRAFTS.token ?? emptyDraft()} update={() => {}} />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-signin-blocked',
    title: 'Onboarding — sign in (gateway too old)',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device."
        say={ctx.say}
        stepIndex={1}
        title="Sign in"
      >
        <SignInStep draft={ONBOARDING_DRAFTS.tooOld ?? emptyDraft()} update={() => {}} />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-test',
    title: 'Onboarding — test connection',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="Hermie checks the REST surface and then opens the WebSocket, exactly as it will during use."
        say={ctx.say}
        stepIndex={2}
        title="Test connection"
      >
        <TestConnectionStep draft={signedIn(ONBOARDING_DRAFTS.gated ?? emptyDraft())} update={() => {}} />
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-test-states',
    title: 'Onboarding — test connection states',
    full: true,
    render: ctx => (
      <OnboardingState
        gated
        lead="Mid-run, and the two ways it fails. Which half failed is the whole diagnosis."
        say={ctx.say}
        stepIndex={2}
        title="Test connection"
      >
        <StatusLine tone="ok">REST</StatusLine>
        <StatusLine tone="checking">WebSocket</StatusLine>
        <StatusLine tone="pending">Profiles</StatusLine>
        <StatusLine tone="error">
          The gateway rejected the credentials. Sign in again, or check the session token.
        </StatusLine>
        <StatusLine tone="error">
          The gateway closed the connection because its `dashboard.public_url` does not match this address.
        </StatusLine>
      </OnboardingState>
    )
  },
  {
    id: 'onboarding-done',
    title: 'Onboarding — ready',
    full: true,
    render: ctx => (
      <OnboardingState
        lead="Hermie will store the gateway address on this device and the credentials in the system secret store."
        primaryLabel="Start chatting"
        say={ctx.say}
        stepIndex={3}
        title="Ready"
      >
        <DoneStep
          draft={{
            ...signedIn(ONBOARDING_DRAFTS.gated ?? emptyDraft()),
            test: {
              botCount: 2,
              key: '',
              plugin: null,
              userDisplayName: 'Fake Tester',
              userEmail: '',
              userPictureUrl: ''
            }
          }}
          error={null}
        />
      </OnboardingState>
    )
  }
]

/** Every id `--hermieOpen gallery:<id>` accepts. Documented in CONTRIBUTING.md. */
export const GALLERY_SECTION_IDS: readonly string[] = SECTIONS.map(section => section.id)

/** `chat` is the whole chat screen, which is a mode rather than a section. */
export const GALLERY_CHAT_SECTION = 'chat'

export function GalleryScreen({ back, section }: GalleryScreenProps) {
  const theme = useTheme()

  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [lastAction, setLastAction] = useState('Nothing yet')

  const target = SECTIONS.find(entry => entry.id === section)

  const [agentsOpen, setAgentsOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalItem>(approvalItem)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [clarifyOpen, setClarifyOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [optionsPane, setOptionsPane] = useState<OptionsPane | undefined>(undefined)
  const [mutedUntil, setMutedUntil] = useState<number | null>(null)
  const [cronEditorOpen, setCronEditorOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(section === GALLERY_CHAT_SECTION)
  const [cronExpanded, setCronExpanded] = useState(false)

  const [yolo, setYolo] = useState(false)
  const [fast, setFast] = useState(true)
  const [reasoning, setReasoning] = useState('medium')
  const [model, setModel] = useState('default')
  const [verbosity, setVerbosity] = useState<Verbosity>('normal')
  const [accent, setAccent] = useState<AccentName>('violet')
  const [showBotToBot, setShowBotToBot] = useState(true)
  const [showThinking, setShowThinking] = useState(false)

  const clarify: ClarifyItem = clarifyItem

  const openSheet = (sheet: SheetName, pane?: OptionsPane) => {
    setOptionsPane(pane)

    switch (sheet) {
      case 'agents':
        return setAgentsOpen(true)
      case 'approval':
        setApproval(approvalItem)

        return setApprovalOpen(true)
      case 'approvalAnswered':
        setApproval({ ...approvalItem, answer: 'once', state: 'answered', version: approvalItem.version + 1 })

        return setApprovalOpen(true)
      case 'clarify':
        return setClarifyOpen(true)
      case 'cronEditor':
        return setCronEditorOpen(true)
      default:
        return setOptionsOpen(true)
    }
  }

  // A section addressed by a launch argument opens its own sheet as it mounts.
  // Without this every sheet, every options page and the colour picker are
  // behind a tap that `xcrun simctl` cannot perform.
  useEffect(() => {
    if (target?.sheet) {
      openSheet(target.sheet, target.pane)
    }
    // Once, for the addressed section. Re-running on every render would fight
    // the reader closing the sheet by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id])

  const ctx: GalleryContext = {
    theme,
    lastAction,
    say: setLastAction,
    draft,
    setDraft,
    running,
    setRunning,
    cronExpanded,
    toggleCron: () => setCronExpanded(current => !current),
    openSheet,
    openChatDemo: () => setTranscriptOpen(true)
  }

  // The transcript demo is its own screen rather than a section: a `FlatList`
  // inside a vertical `ScrollView` is a nested virtualized list, which React
  // Native warns about and which measures wrong on every platform. Giving it
  // the whole screen is also the honest demo — header, agents bar, list and
  // composer in the layout a real chat uses.
  const chatDemo = (
    <Screen edgeToEdgeTop={false} padded={false} testID="gallery-chat">
      <ChatHeader
        name="researcher"
        secondaryName="Researcher"
        onBack={() => setTranscriptOpen(false)}
        onOpenOptions={() => setOptionsOpen(true)}
        presence="working"
      />

      <TranscriptList
        header={<AgentsBar count={3} elapsedSeconds={72} onPress={() => setAgentsOpen(true)} />}
        items={galleryTranscript}
        onOpenBot={handle => setLastAction(`Open bot @${handle}`)}
        onOpenRequest={item => (item.kind === 'approval' ? setApprovalOpen(true) : setClarifyOpen(true))}
        onOpenTranscript={id => setLastAction(`Open transcript ${id}`)}
        onRetry={id => setLastAction(`Retry ${id}`)}
        receipt="delivered"
        subagents={subagentMap}
        testID="gallery-transcript"
        typing={running}
      />

      <Composer
        botName="Researcher"
        // Nothing above it is avoiding the keyboard here, unlike in a chat.
        keyboardAvoiding
        onAttach={() => setLastAction('Attach pressed')}
        onChangeText={setDraft}
        onSend={text => {
          setLastAction(`Sent: ${text}`)
          setDraft('')
          setRunning(true)
        }}
        onStop={() => setRunning(false)}
        running={running}
        suggestions={SLASH_SUGGESTIONS}
        value={draft}
      />
    </Screen>
  )

  // One addressed section, alone. `full` sections draw their own screen; the
  // rest get the plain padded box, because a section boxed inside a bordered
  // card is a screenshot of a card rather than of the component.
  const single = target ? (
    target.full ? (
      <>{target.render(ctx)}</>
    ) : (
      <PageFrame {...(back ? { back } : {})} testID={`gallery-section-${target.id}`} title={target.title}>
        <PageScrollView contentContainerStyle={{ gap: theme.space.md, padding: theme.space.lg }}>
          {target.render(ctx)}
        </PageScrollView>
      </PageFrame>
    )
  ) : null

  const componentList = (
    <PageFrame {...(back ? { back } : {})} title={GALLERY_ROW_TITLE}>
      <PageScrollView contentContainerStyle={{ gap: theme.space.xl, padding: theme.space.lg }}>
        <View style={{ gap: theme.space.sm }}>
          <Text color="textMuted" variant="preview">
            Every chat surface with fixture data. Last action: {lastAction}
          </Text>
        </View>

        {SECTIONS.filter(entry => !entry.full && !entry.sheet && !entry.needsGateway).map(entry => (
          <Section key={entry.id} title={entry.title}>
            {entry.render(ctx)}
          </Section>
        ))}

        <View style={{ height: theme.space.xxxl }} />
      </PageScrollView>
    </PageFrame>
  )

  // The sheets are rendered once, outside the body switch: a `Modal` that
  // unmounts because the screen behind it changed would take its own dismiss
  // animation with it.
  return (
    <>
      {transcriptOpen ? chatDemo : (single ?? componentList)}

      <AgentsSheet
        onClose={() => setAgentsOpen(false)}
        onInterrupt={id => setLastAction(`Stop ${id}`)}
        onOpenTranscript={id => setLastAction(`Open transcript ${id}`)}
        onSteer={(id, text) => setLastAction(`Steer ${id}: ${text}`)}
        tree={subagentTree}
        visible={agentsOpen}
      />

      <ApprovalSheet
        botHandle="researcher"
        item={approval}
        onClose={() => {
          setApprovalOpen(false)
          setApproval(approvalItem)
        }}
        onRespond={choice => {
          setApproval(current => ({ ...current, answer: choice, state: 'answered', version: current.version + 1 }))
          setLastAction(`Approval: ${choice}`)
        }}
        visible={approvalOpen}
        workingDirectory="/workspace/docs"
      />

      <ClarifySheet
        item={clarify}
        onClose={() => setClarifyOpen(false)}
        onLock={(qid, answer) => setLastAction(`Locked ${qid}: ${answer}`)}
        onSkip={() => {
          setClarifyOpen(false)
          setLastAction('Clarify skipped')
        }}
        onSubmit={answers => {
          setClarifyOpen(false)
          setLastAction(`Clarify: ${JSON.stringify(answers)}`)
        }}
        visible={clarifyOpen}
      />

      <CronEditorSheet
        job={null}
        onCancel={() => setCronEditorOpen(false)}
        onSave={input => {
          setCronEditorOpen(false)
          setLastAction(`Save cron ${input.name}`)
        }}
        profiles={['researcher', 'writer', 'bookkeeper']}
        targets={CRON_TARGETS}
        visible={cronEditorOpen}
      />

      <ChatOptionsSheet
        accent={accent}
        botName="Researcher"
        fast={fast}
        initialPane={optionsPane}
        model={model}
        modelOptions={MODEL_OPTIONS}
        mutedUntil={mutedUntil}
        onChangeAccent={setAccent}
        onChangeMute={setMutedUntil}
        onChangeFast={setFast}
        onChangeModel={setModel}
        onChangeReasoningEffort={setReasoning}
        onChangeShowBotToBot={setShowBotToBot}
        onChangeShowThinking={setShowThinking}
        onChangeVerbosity={setVerbosity}
        onChangeYolo={setYolo}
        onClose={() => setOptionsOpen(false)}
        onPickExpensiveModel={value => setLastAction(`Confirm expensive model ${value}`)}
        reasoningEffort={reasoning}
        reasoningOptions={REASONING_OPTIONS}
        showBotToBot={showBotToBot}
        showThinking={showThinking}
        verbosity={verbosity}
        visible={optionsOpen}
        yolo={yolo}
      />
    </>
  )
}
