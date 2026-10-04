/**
 * What the gateway-management Settings pages (Memory, Skills, MCP servers, Connectors, Boards) are given by the
 * page: the two halves of the gateway they talk to, the socket's calls and the REST client. It rides in
 * `SettingsRuntime.manage` (`settings-runtime.ts`), so the shell needs no provider of its own; each page builds
 * what it needs on it when it is opened, and nothing of any of them is in the first load.
 *
 * Optional, like every runtime: a screen rendered with none (a test of the shell) draws what it can and acts on
 * nothing.
 */
import type { ManageTransport } from '../../core/manage/transport'
import { useSettingsRuntime } from './settings-runtime'

export type { ManageTransport }

export interface ManageRuntime {
  transport: ManageTransport
}

/** The page's management transport, or `null` where the page has not provided one. */
export const useManageTransport = (): ManageTransport | null => useSettingsRuntime()?.manage?.transport ?? null
