/**
 * The Hermie blocks this page draws in a reply, by the names the gateway has a guide paragraph for.
 *
 * `client.capabilities {markup: [...]}` (the passkey model's second call, `core/passkey/model.ts`) tells the gateway,
 * which tells a bot about exactly these blocks on a turn this page submits and on no other. A name is listed only
 * when the page really draws it: the fork's `tui_gateway/client_markup.py` removes a name from its vocabulary the
 * day a block misbehaves, and a name added here before its renderer exists would have bots write blocks the page
 * shows as code.
 *
 *  - `chart`: a `hermie-chart` fence, drawn by `markdown/Chart.tsx`.
 *  - `cards`: a `hermie-cards` fence, drawn by `markdown/Cards.tsx`.
 *  - `alerts`: a quote that begins `[!NOTE]` (`[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), drawn as a callout
 *    by `markdown/Alert.tsx`.
 *
 * Sorted, as the gateway echoes them. The contract is `contract/markup/`.
 */
export const WEB_MARKUP: readonly string[] = Object.freeze(['alerts', 'cards', 'chart'])
