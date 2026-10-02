/**
 * What each memory backend is actually holding.
 *
 * The Entries tab shows a memory PARSED — the file split on the store's own
 * `"\n§\n"` delimiter, one row per entry, which is the right shape for editing
 * it. It is the wrong shape for the question "what is in there": a heading, a
 * blank line the store kept, a delimiter that ended up inside an entry, and the
 * order the file really has are all invisible in a list of rows. And for an
 * external provider — mem0 and its kind — the browser says only that it exists,
 * because `list` names it and marks it `enumerable: false`.
 *
 * So this tab asks a route of its own and shows one card per backend: the
 * built-in one with its documents as stored, and every other one with either
 * its documents or the reason it has none. A backend that is configured and
 * cannot be listed is a different answer from a backend the gateway does not
 * have, and both are different from an error — all three are said in their own
 * words rather than as an empty page.
 *
 * **Read-only, and the tab says so once.** The only write the plugin has is
 * entry-shaped (`op: add|replace|remove` against a target), so there is nothing
 * here that could save a whole document back. `editable` arrives on the wire
 * for the day there is, and until then a tab that offered a text box would be
 * offering a button that cannot work.
 */
import { View } from 'react-native'

import { MONOSPACE } from '../../markdown/context'
import { InsetGroup, InsetRow, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { MemoryBackendRaw, MemoryRaw } from './model'
import { memoryStrings } from './strings'

export interface MemoryRawTabProps {
  raw: MemoryRaw | null
  loading: boolean
  /** The gateway's plugin has no such route. A capability answer, not a failure. */
  missing: boolean
  testID?: string
}

export function MemoryRawTab({ raw, loading, missing, testID = 'memory' }: MemoryRawTabProps) {
  if (missing) {
    return (
      <InsetGroup
        footer={
          <Text color="textMuted" variant="meta">
            {memoryStrings.raw.missingHint}
          </Text>
        }
      >
        <InsetRow>
          <Text color="textMuted" testID={`${testID}-raw-missing`}>
            {memoryStrings.raw.missing}
          </Text>
        </InsetRow>
        <InsetRow>
          <Text testID={`${testID}-raw-missing-command`} variant="code">
            {memoryStrings.raw.missingCommand}
          </Text>
        </InsetRow>
      </InsetGroup>
    )
  }

  if (loading && !raw) {
    return (
      <Text color="textMuted" testID={`${testID}-raw-loading`} variant="meta">
        {memoryStrings.raw.loading}
      </Text>
    )
  }

  if (!raw || raw.backends.length === 0) {
    return (
      <Text color="textMuted" testID={`${testID}-raw-none`} variant="meta">
        {memoryStrings.raw.none}
      </Text>
    )
  }

  return (
    <>
      <Text color="textMuted" testID={`${testID}-raw-read-only`} variant="meta">
        {memoryStrings.raw.readOnly}
      </Text>

      {raw.backends.map(backend => (
        <BackendCard backend={backend} key={backend.name} testID={testID} />
      ))}
    </>
  )
}

function BackendCard({ backend, testID }: { backend: MemoryBackendRaw; testID: string }) {
  const theme = useTheme()

  /*
    Three states, and the difference between them is the whole point of the
    card. Not available: the gateway does not have this backend. Available with
    no documents: it is configured and cannot enumerate, which is what every
    external provider is today — its own `note` says why, in the gateway's
    words rather than ours, and the generic sentence is the fallback for a
    gateway that sent none.
  */
  if (!backend.available) {
    return (
      <InsetGroup header={backend.label} testID={`${testID}-raw-${backend.name}`}>
        <InsetRow>
          <Text color="textMuted" testID={`${testID}-raw-${backend.name}-unavailable`} variant="meta">
            {memoryStrings.raw.unavailable}
          </Text>
        </InsetRow>
      </InsetGroup>
    )
  }

  if (backend.documents.length === 0) {
    return (
      <InsetGroup header={backend.label} testID={`${testID}-raw-${backend.name}`}>
        <InsetRow>
          <Text color="textMuted" testID={`${testID}-raw-${backend.name}-note`} variant="meta">
            {backend.note ?? memoryStrings.raw.notListable}
          </Text>
        </InsetRow>
      </InsetGroup>
    )
  }

  return (
    <InsetGroup header={backend.label} testID={`${testID}-raw-${backend.name}`}>
      {backend.documents.map(document => (
        <InsetRow key={document.id}>
          <View style={{ gap: theme.space.xs }}>
            <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
              <Text style={{ flex: 1 }} variant="name">
                {document.label}
              </Text>
              <Text color="textMuted" variant="meta">
                {memoryStrings.raw.chars(document.chars)}
              </Text>
            </View>

            {document.content ? (
              /*
                Monospace and `selectable`, drawn as the gateway wrote it —
                newlines, delimiters and all. `selectable` because the reason to
                open this tab is usually to copy a piece of it into a bug report.
              */
              <Text
                selectable
                style={{
                  fontFamily: MONOSPACE,
                  fontSize: theme.type.meta.fontSize,
                  lineHeight: theme.type.body.lineHeight
                }}
                testID={`${testID}-raw-${backend.name}-${document.id}`}
              >
                {document.content}
              </Text>
            ) : (
              <Text color="textMuted" testID={`${testID}-raw-${backend.name}-${document.id}-empty`} variant="meta">
                {memoryStrings.raw.emptyDocument}
              </Text>
            )}

            {document.truncated ? (
              <Text color="textMuted" variant="meta">
                {memoryStrings.raw.truncated}
              </Text>
            ) : null}
          </View>
        </InsetRow>
      ))}
    </InsetGroup>
  )
}
