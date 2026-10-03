/**
 * Inline tokens as React elements.
 *
 * Only these elements are ever made here: `strong`, `em`, `del`, `code`, `br`,
 * `a` and `img`, plus text. Raw HTML in a message is a token like any other and
 * is drawn as the characters the agent typed; nothing parses it, so there is
 * nothing for a sanitiser to miss. Every string reaches the DOM as a React text
 * child or as an attribute value that went through `links.ts` first.
 */
import { MATH_INLINE_TOKEN, type MathToken, type Token, type Tokens } from '@hermie/markdown'
import { Fragment, useState, type ReactNode } from 'react'

import { LINK_REL, LINK_TARGET, openableHref, resolveImage } from './links'

export interface InlineProps {
  tokens: Token[]
  /** The gateway's base URL; what an image source is resolved against. */
  baseUrl: string | undefined
}

/** An image on the gateway's origin, or the alt text when it cannot be shown. */
function InlineImage({
  token,
  baseUrl,
  inLink
}: {
  token: Tokens.Image
  baseUrl: string | undefined
  inLink: boolean
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const source = resolveImage(token.href, baseUrl)
  const alt = token.text || token.title || ''

  if (source.kind === 'image' && failed !== source.src) {
    return (
      <img
        alt={token.text}
        className="md-image"
        decoding="async"
        loading="lazy"
        onError={() => setFailed(source.src)}
        src={source.src}
        {...(token.title ? { title: token.title } : {})}
      />
    )
  }

  if (source.kind === 'link' && !inLink) {
    // The label is what the agent said the picture shows; the address is the
    // fallback when it said nothing, so a link never has an empty name.
    return (
      <a className="md-image-link" href={source.href} rel={LINK_REL} target={LINK_TARGET}>
        {alt || source.href}
      </a>
    )
  }

  return alt ? <span className="md-image-alt">{alt}</span> : null
}

function renderToken(token: Token, index: number, baseUrl: string | undefined, inLink: boolean): ReactNode {
  const key = `${token.type}-${index}`
  const nested = (token as { tokens?: Token[] }).tokens

  switch (token.type) {
    case 'strong':
      return <strong key={key}>{renderInline(nested ?? [], baseUrl, inLink)}</strong>

    case 'em':
      return <em key={key}>{renderInline(nested ?? [], baseUrl, inLink)}</em>

    case 'del':
      return <del key={key}>{renderInline(nested ?? [], baseUrl, inLink)}</del>

    case 'codespan':
      return (
        <code className="md-code-inline" key={key}>
          {(token as Tokens.Codespan).text}
        </code>
      )

    // Drawn as its source until the math renderer arrives (W-21).
    case MATH_INLINE_TOKEN:
      return (
        <code className="md-code-inline md-math" data-math="" key={key}>
          {(token as unknown as MathToken).text}
        </code>
      )

    case 'br':
      return <br key={key} />

    // The `[x] ` of a task item: the list item draws it as a checkbox. A tight
    // item keeps it as a block-level token, a loose one as the first inline token.
    case 'checkbox':
      return null

    case 'link': {
      const link = token as Tokens.Link
      const href = inLink ? null : openableHref(link.href)
      const children = nested?.length ? renderInline(nested, baseUrl, true) : link.text

      // A link that may not be opened keeps its words and loses the link.
      if (!href) {
        return <Fragment key={key}>{children}</Fragment>
      }

      return (
        <a href={href} key={key} rel={LINK_REL} target={LINK_TARGET} {...(link.title ? { title: link.title } : {})}>
          {children}
        </a>
      )
    }

    case 'image':
      return <InlineImage baseUrl={baseUrl} inLink={inLink} key={key} token={token as Tokens.Image} />

    // Raw HTML is text. This is the whole HTML policy.
    case 'html':
      return <Fragment key={key}>{(token as Tokens.HTML).raw}</Fragment>

    case 'text':
    case 'escape':
    default:
      if (nested?.length) {
        return <Fragment key={key}>{renderInline(nested, baseUrl, inLink)}</Fragment>
      }

      return (
        <Fragment key={key}>
          {(token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? ''}
        </Fragment>
      )
  }
}

function renderInline(tokens: Token[], baseUrl: string | undefined, inLink: boolean): ReactNode[] {
  return tokens.map((token, index) => renderToken(token, index, baseUrl, inLink))
}

export function Inline({ tokens, baseUrl }: InlineProps) {
  return <>{renderInline(tokens, baseUrl, false)}</>
}
