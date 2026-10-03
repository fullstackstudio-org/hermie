/**
 * Transcript items and chats for a screen test, built literally: no engine, no
 * gateway. A test that is about what a row draws says so with three fields; a
 * test that is about the engine's own behaviour replays a recorded scenario
 * instead (`dev/stream-replay.ts`).
 */
import {
  type AssistantItem,
  type BotDmInItem,
  type BotDmOutItem,
  type ChatState,
  type CronDeliveryItem,
  createChatState,
  type NoticeItem,
  type StatusItem,
  type SubagentGroupItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from '@hermie/transcript'

import { LONG_AGO } from './shell-stores'

let counter = 0

const base = (kind: TranscriptItem['kind'], id: string | undefined, ts: number | undefined) => {
  counter += 1

  return {
    id: id ?? `${kind}-${counter}`,
    seq: counter * 1000,
    origin: 'history' as const,
    version: 1,
    ...(ts === undefined ? {} : { ts })
  }
}

export const userItem = (text: string, over: Partial<UserItem> = {}, id?: string): UserItem => ({
  ...base('user', id, over.ts ?? LONG_AGO),
  kind: 'user',
  text,
  ...over
})

export const assistantItem = (text: string, over: Partial<AssistantItem> = {}, id?: string): AssistantItem => ({
  ...base('assistant', id, over.ts ?? LONG_AGO),
  kind: 'assistant',
  text,
  streaming: false,
  interim: false,
  ...over
})

export const toolItem = (name: string, over: Partial<ToolItem> = {}, id?: string): ToolItem => ({
  ...base('tool', id, over.ts ?? LONG_AGO),
  kind: 'tool',
  toolId: `call-${counter}`,
  name,
  status: 'complete',
  resultKnown: true,
  ...over
})

export const noticeItem = (title: string, over: Partial<NoticeItem> = {}, id?: string): NoticeItem => ({
  ...base('notice', id, over.ts ?? LONG_AGO),
  kind: 'notice',
  noticeKind: 'notice',
  title,
  ...over
})

export const statusItem = (text: string, over: Partial<StatusItem> = {}, id?: string): StatusItem => ({
  ...base('status', id, over.ts ?? LONG_AGO),
  kind: 'status',
  statusKind: 'lifecycle',
  text,
  ...over
})

export const botDmInItem = (text: string, over: Partial<BotDmInItem> = {}, id?: string): BotDmInItem => ({
  ...base('bot_dm_in', id, over.ts ?? LONG_AGO),
  kind: 'bot_dm_in',
  senderName: 'Writer',
  senderHandle: 'writer',
  text,
  ...over
})

export const botDmOutItem = (message: string, over: Partial<BotDmOutItem> = {}, id?: string): BotDmOutItem => ({
  ...base('bot_dm_out', id, over.ts ?? LONG_AGO),
  kind: 'bot_dm_out',
  toolId: `call-${counter}`,
  target: '@writer',
  targetHandle: 'writer',
  message,
  dispatch: { status: 'queued' },
  ...over
})

export const cronDeliveryItem = (
  body: string,
  over: Partial<CronDeliveryItem> = {},
  id?: string
): CronDeliveryItem => ({
  ...base('cron_delivery', id, over.ts ?? LONG_AGO),
  kind: 'cron_delivery',
  jobName: 'Source scan',
  body,
  shape: 'bot_chat',
  ...over
})

export const subagentGroupItem = (
  goals: string[],
  over: Partial<SubagentGroupItem> = {},
  id?: string
): SubagentGroupItem => ({
  ...base('subagent_group', id, over.ts ?? LONG_AGO),
  kind: 'subagent_group',
  goals,
  rootIds: [],
  status: 'running',
  ...over
})

/** A live chat holding exactly these items, in this order. */
export function chatWith(botName: string, items: readonly TranscriptItem[], over: Partial<ChatState> = {}): ChatState {
  const empty = createChatState(botName, `stored-${botName}`, `stored-${botName}`)

  return {
    ...empty,
    items: Object.fromEntries(items.map(item => [item.id, item])),
    order: items.map(item => item.id),
    hydration: 'live',
    ...over
  }
}

/** Seconds, one day apart from `LONG_AGO` by `days`. */
/**
 * Local midnight of the day `LONG_AGO` falls on, in unix seconds. The date rows key on the local
 * calendar, so a stamp a few hours into a day must stay on that day whatever the test runner's zone.
 */
const LONG_AGO_DAY_START = ((): number => {
  const at = new Date(LONG_AGO * 1000)

  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() / 1000
})()

export const daysAfter = (days: number, secondsIntoDay = 0): number =>
  LONG_AGO_DAY_START + days * 86_400 + secondsIntoDay
