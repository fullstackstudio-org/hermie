/**
 * Connectors as the settings page calls them: with an OWNER (`{type: "account"}`) and no chat, and the vendor's
 * row following the operation. The account watcher is what moves the row upstream, so a list read after a
 * connector settled says it is connected, and one that failed says nothing of the sort.
 */
import { describe, expect, it } from 'vitest'

import { withGateway } from './testing/socket-call'

const account = { type: 'account' }

describe('connectors for the account', () => {
  it('lists without a chat, and refuses a top-level session_id as the real gateway does', async () => {
    await withGateway(async call => {
      const list = (await call('connectors.list', { owner: account })) as {
        available: boolean
        connectors: { connector: string }[]
      }

      expect(list.available).toBe(true)
      expect(list.connectors.map(row => row.connector)).toEqual(['gmail', 'notion', 'slack'])
      await expect(call('connectors.list', { session_id: 'x' })).rejects.toMatchObject({ code: 4000 })
    })
  })

  it('moves the vendor’s row to connected when the operation settles connected, and not when it fails', async () => {
    await withGateway(async call => {
      const row = async (slug: string) =>
        (
          (await call('connectors.list', { owner: account })) as { connectors: Record<string, unknown>[] }
        ).connectors.find(entry => entry.connector === slug)

      const notion = (await call('connectors.connect', { owner: account, connectors: ['notion'] })) as { op_id: string }

      expect(await row('notion')).toMatchObject({ connected: false })

      await call('connectors.operation.status', { owner: account, op_id: notion.op_id })
      await call('connectors.operation.status', { owner: account, op_id: notion.op_id })

      expect(await row('notion')).toMatchObject({ connected: true, connectionStatus: 'active', statusReason: null })

      const slack = (await call('connectors.connect', { owner: account, connectors: ['slack'] })) as { op_id: string }

      await call('connectors.operation.status', { owner: account, op_id: slack.op_id })
      await call('connectors.operation.status', { owner: account, op_id: slack.op_id })

      expect(await row('slack')).toMatchObject({ connected: false, connectionStatus: 'failed' })
    })
  })
})
