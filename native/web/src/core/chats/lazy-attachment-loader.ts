/**
 * `createAttachmentLoader`, loaded when the first attachment is fetched.
 *
 * The code that turns an attachment reference into a request and judges the answer by its first bytes is
 * needed only by a chat that holds an attachment someone has to open or a picture to fetch, so it is not in
 * the page's first load (`npm run client:check-bundle` holds that to a budget): this is the one seam, and the
 * module behind it arrives with the first fetch. `profile` is the chat's own, which says whether a path is one of
 * that profile's attached images.
 */
import type { AttachmentFetcher, LoadedAttachment } from './attachment-fetch'

export function lazyAttachmentLoader(
  fetcher: AttachmentFetcher,
  profile?: string
): (reference: string) => Promise<LoadedAttachment | null> {
  let loader: Promise<(reference: string) => Promise<LoadedAttachment | null>> | undefined

  return async reference => {
    loader ??= import('./attachment-fetch').then(module => module.createAttachmentLoader(fetcher, profile))

    try {
      return await (
        await loader
      )(reference)
    } catch {
      // The chunk did not arrive: the next ask tries again, and this one is a refusal the chip can say.
      loader = undefined

      return null
    }
  }
}
