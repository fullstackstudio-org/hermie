/**
 * What a tapped node actually is.
 *
 * The graph node carries an EXCERPT — the plugin caps it at 120 characters,
 * because a graph is drawn rather than read and the full text in every node is
 * how a payload becomes megabytes. So the card looks the entry up in the
 * listing the page already holds and shows the whole of it, falling back to the
 * excerpt when the two answers disagree about which entries exist, which they
 * can: the graph and the listing are two reads of a file anything on the
 * gateway may have rewritten in between.
 *
 * "Show in the list" is the card's one action and it leaves the map. That is
 * deliberate rather than an editor here: the list is where an entry can be
 * changed, and two places to edit one entry is two places to get the
 * stale-index rule wrong.
 */
import { View } from 'react-native'

import { Button, InsetGroup, InsetRow, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { type MemoryGraph, type MemoryGraphNode, topicsOf } from './graph-model'
import type { MemoryListing } from './model'
import { memoryStrings } from './strings'

export interface MemoryNodeCardProps {
  node: MemoryGraphNode
  graph: MemoryGraph
  /** Where the full text comes from; the node only carries an excerpt. */
  listing: MemoryListing | null
  /** Only offered for an entry node, and only when the entry is in the list. */
  onOpenInList?: (entryId: string) => void
  onClose: () => void
  testID?: string
}

export function MemoryNodeCard({
  node,
  graph,
  listing,
  onOpenInList,
  onClose,
  testID = 'memory-graph-card'
}: MemoryNodeCardProps) {
  const theme = useTheme()
  const entry = (listing?.sections ?? []).flatMap(section => section.entries).find(row => row.id === node.id)
  const topics = node.type === 'entry' ? topicsOf(graph, node.id) : []

  const kind =
    node.type === 'profile'
      ? memoryStrings.graph.detail.profile
      : node.type === 'topic'
        ? memoryStrings.graph.detail.topic
        : memoryStrings.graph.detail.entry

  return (
    <InsetGroup header={kind} testID={testID}>
      <InsetRow>
        <Text selectable testID={`${testID}-text`} variant="body">
          {entry?.text ?? node.label}
        </Text>
      </InsetRow>

      {node.type === 'entry' ? (
        <InsetRow>
          <Text color="textMuted" variant="meta">
            {memoryStrings.graph.detail.topics}
          </Text>
          <Text testID={`${testID}-topics`} variant="meta">
            {topics.length ? topics.join(' · ') : memoryStrings.graph.detail.noTopics}
          </Text>
        </InsetRow>
      ) : null}

      <InsetRow>
        <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
          {node.type === 'entry' && entry && onOpenInList ? (
            <View style={{ flex: 1 }}>
              <Button
                onPress={() => onOpenInList(entry.id)}
                testID={`${testID}-open`}
                title={memoryStrings.graph.detail.open}
                variant="secondary"
              />
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Button
              onPress={onClose}
              testID={`${testID}-close`}
              title={memoryStrings.graph.detail.close}
              variant="secondary"
            />
          </View>
        </View>
      </InsetRow>
    </InsetGroup>
  )
}
