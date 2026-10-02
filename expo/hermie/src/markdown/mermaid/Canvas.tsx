/**
 * The box a diagram is drawn in, and the labels laid over it.
 *
 * Shared by the sequence diagram and the pie, which are the two kinds whose
 * labels arrive from their layout as placed boxes. Three things live here because
 * all three have to be decided the same way for every kind, or the drawings stop
 * looking like one feature:
 *
 *  - **It scales, it does not reflow.** A drawing has a natural size in its own
 *    units; where the bubble is narrower, the whole picture is scaled down by a
 *    single factor and the `viewBox` does the work, so nothing is re-laid-out and
 *    the aspect ratio holds. A diagram wider than the bubble therefore gets
 *    smaller rather than getting a scroll view — deliberately, because a
 *    horizontal scroller inside a vertical list eats drags that started on it,
 *    which `Block.tsx` says about tables for the same reason.
 *  - **The labels are real `Text`, not SVG text.** `react-native-svg`'s own
 *    `Text` measures on the native side with metrics that differ per platform, so
 *    a label would sit inside its box on one target and outside it on another. A
 *    `Text` positioned over the drawing uses the same text engine as the rest of
 *    the bubble and — the part that matters — is SELECTABLE and reaches a screen
 *    reader, which text inside an `Svg` is not.
 *  - **Nothing carries a colour of its own.** Ink, hairlines and surfaces all come
 *    from the markdown context, so dark mode is whatever the surrounding bubble
 *    already decided.
 */

import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import Svg from 'react-native-svg'

import type { MarkdownContext } from '../context'
import { diagramLineHeight, type DiagramText } from './labels'

/**
 * Every placed label, over the drawing.
 *
 * A label's box is what the layout said it was, scaled — never sized by its own
 * content — so the text sits exactly where the geometry expects it even when this
 * platform's face is a little wider than the estimate.
 */
export function TextLayer({
  texts,
  context,
  scale
}: {
  texts: readonly DiagramText[]
  context: MarkdownContext
  scale: number
}) {
  return (
    <>
      {texts.map((text, index) => {
        const lineHeight = diagramLineHeight(text.size)
        const align = text.align === 'center' ? 'center' : text.align === 'right' ? 'flex-end' : 'flex-start'

        return (
          <View
            key={index}
            pointerEvents="none"
            style={{
              alignItems: align,
              height: text.height * scale,
              justifyContent: 'center',
              left: text.x * scale,
              position: 'absolute',
              top: text.y * scale,
              width: text.width * scale,
              // No `overflow: 'hidden'` on the chip: its width is an ESTIMATE, and
              // clipping to an estimate is how a label loses its last letter on
              // the one platform whose face is a shade wider.
              ...(text.chip ? { backgroundColor: context.blockBackground, borderRadius: 4 * scale } : {})
            }}
          >
            {text.lines.map((line, at) => (
              <Text
                key={at}
                selectable={context.selectable}
                style={{
                  color: text.tone === 'muted' ? context.mutedTextColor : context.textColor,
                  fontSize: text.size * scale,
                  lineHeight: lineHeight * scale,
                  textAlign: text.align
                }}
              >
                {line}
              </Text>
            ))}
          </View>
        )
      })}
    </>
  )
}

/**
 * One diagram: the bordered box, the drawing, and the labels over it.
 *
 * `children` are the SVG elements in the drawing's OWN units. The `viewBox` maps
 * them onto however many points the bubble can spare, which is why a renderer
 * never has to know the scale it ended up at.
 */
export function DiagramCanvas({
  layout,
  context,
  testID,
  children
}: {
  layout: { width: number; height: number; texts: readonly DiagramText[] }
  context: MarkdownContext
  testID: string
  children: ReactNode
}) {
  // Down only. A four-column diagram blown up to the width of an iPad is a
  // poster, and the reader asked for a diagram in a message.
  const scale = context.contentWidth ? Math.min(1, context.contentWidth / layout.width) : 1
  const width = layout.width * scale
  const height = layout.height * scale

  return (
    <View
      style={{
        backgroundColor: context.blockBackground,
        borderColor: context.borderColor,
        borderRadius: 12,
        borderWidth: 1,
        marginVertical: 8,
        padding: 8
      }}
      testID={testID}
    >
      <View style={{ height, width }}>
        <Svg height={height} viewBox={`0 0 ${layout.width} ${layout.height}`} width={width}>
          {children}
        </Svg>

        <TextLayer context={context} scale={scale} texts={layout.texts} />
      </View>
    </View>
  )
}
