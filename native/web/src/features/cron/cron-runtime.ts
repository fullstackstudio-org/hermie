/**
 * What the Crons pages are given by the page: the two halves of the gateway they talk to (the socket's calls and
 * events, and the REST client). The controller built on them (`core/cron/controller.ts`) is made by the Crons
 * chunk when a Crons route opens, so nothing of it is in the first load: this file is the one thing the entry
 * imports, and it holds no more than the context.
 *
 * A context, like `McpRuntimeContext`, and optional for the same reason: a screen rendered with none (a test of the
 * shell) draws what the store holds and acts on nothing.
 */
import { createContext, useContext } from 'react'

import type { CronTransport } from '../../core/cron/controller'

export interface CronRuntime {
  transport: CronTransport
}

export const CronRuntimeContext = createContext<CronRuntime | null>(null)

/** The page's cron runtime, or `null` where the page has not provided one. */
export const useCronRuntime = (): CronRuntime | null => useContext(CronRuntimeContext)
