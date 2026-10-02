/**
 * Opening a file picker in a browser: one `<input type="file">`, created on
 * demand and thrown away again.
 *
 * `expo-document-picker` does have a web implementation and it is deliberately
 * not used: it returns a `data:` URI, which means the whole file is base64'd
 * into a JavaScript string before anything has decided to upload it. A 90 MB
 * archive would cost 120 MB of string, which is exactly what the streaming
 * upload exists to avoid. The `File` the DOM already has streams straight into
 * a `FormData`.
 *
 * What a browser does NOT give, and the phones do:
 *
 *  - No answer when the user cancels. There is no cancel event on `<input>`
 *    that fires reliably across browsers, so this resolves on `change` and on
 *    the window regaining focus without one — the second is the cancel, and it
 *    is a heuristic rather than a fact.
 *  - No local URI for a thumbnail that survives a reload; `URL.createObjectURL`
 *    lives only as long as the document.
 */
import type { PickedFileSource } from './platform-contracts'

export type { PickedFileSource } from './platform-contracts'

export function openFilePicker(): Promise<PickedFileSource | null> {
  if (typeof document === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise<PickedFileSource | null>(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = false
    // Off-screen rather than `display: none`: some browsers refuse to open a
    // picker for an input that is not laid out at all.
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    document.body.appendChild(input)

    let settled = false

    const finish = (value: PickedFileSource | null) => {
      if (settled) {
        return
      }

      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(value)
    }

    const onFocus = () => {
      // The focus event arrives before `change` does, so give the picker a
      // moment to deliver a file before calling it a cancel.
      setTimeout(() => finish(null), 500)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]

      finish(
        file
          ? {
              uri: URL.createObjectURL(file),
              name: file.name,
              size: file.size,
              mimeType: file.type || null,
              body: file
            }
          : null
      )
    })

    window.addEventListener('focus', onFocus)
    input.click()
  })
}
