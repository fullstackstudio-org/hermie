/**
 * The two halves of the gateway the management pages (Memory, Skills, MCP servers, Connectors, Boards) and the
 * bot profile's personality and model talk to: the socket's calls, and the REST client. Each core in this folder
 * is written against this and not against the connection, so a test hands in a few functions and needs no socket.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

import type { ChatGateway } from '../link'

export interface ManageTransport {
  gateway: Pick<ChatGateway, 'request'>
  http: Pick<GatewayHttp, 'get' | 'post' | 'patch' | 'delete'>
}
