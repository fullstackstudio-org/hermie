package nl.fullstackstudio.hermie.share

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.util.Locale
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Turning an `ACTION_SEND` intent into the same outbox entry an iOS share
 * extension writes.
 *
 * The two platforms arrive at this feature from opposite directions and meet
 * here. iOS runs a separate process with its own sheet, reads the roster out of
 * an App Group and writes an entry naming a bot. Android has no extension at
 * all: the system's own chooser picks Hermie, the intent reaches MainActivity,
 * and the question "which chat" is asked afterwards by the app itself.
 *
 * So an entry written here has **no `bot` field**, which the file format allows
 * on purpose — see `src/features/share/outbox.ts`. Everything else about the
 * manifest is identical, which is what lets `share-delivery.ts` have no
 * platform branch in it.
 *
 * ## There is no App Group here, and none is needed
 *
 * `ACTION_SEND` reaches the app's own process. The entry therefore goes in
 * `filesDir`, the same place the widget avatars go, and nothing crosses a
 * sandbox boundary. The directory names are shared with the Apple side because
 * the FILE FORMAT is shared, not because the location is.
 *
 * ## Absorbing an intent is a write, and it happens once
 *
 * An `ACTION_SEND` intent stays on the activity until something replaces it, so
 * reading it twice would write the same share twice. `absorb` clears the action
 * after a successful write, which makes the second read a no-op — and makes the
 * whole thing idempotent under the one thing that reliably calls it twice, a
 * React re-render that pumps the outbox again.
 */
object HermieShareStore {
  /** Also spelled in `outbox.ts` as `SHARE_OUTBOX_DIRECTORY`. */
  const val DIRECTORY = "share-outbox"

  /** Also spelled in `outbox.ts` as `SHARE_MANIFEST_FILE`. */
  const val MANIFEST = "manifest.json"

  /**
   * `SHARE_CLAIM_FILE`.
   *
   * Nothing on this platform writes one — the iOS share extension does, because
   * only it delivers a share itself (ADR-0026, and see the Android note there for
   * why there is no counterpart here yet). It is read anyway, so that the file
   * format has one meaning on both platforms rather than two: an entry carrying a
   * claim is an entry the app must ask about, whoever wrote it.
   */
  const val CLAIM = "claim.json"

  /** `SHARE_MANIFEST_VERSION`. Bumped on both sides or neither. */
  const val VERSION = 1

  /** `SHARE_ITEM_LIMIT`, applied before anything is copied. */
  const val ITEM_LIMIT = 12

  /** A ceiling on the JSON read back, for the reason the Swift module gives. */
  private const val MAX_MANIFEST_BYTES = 256 * 1024

  fun outbox(context: Context): File = File(context.filesDir, DIRECTORY)

  /**
   * Write this intent into the outbox, if it is a share and has not been
   * written already. Answers the entry's id, or null.
   *
   * `ACTION_SEND` and `ACTION_SEND_MULTIPLE` are both handled, and the only
   * difference between them is where the streams are: one `EXTRA_STREAM`, or a
   * list of them. `EXTRA_TEXT` can accompany either, and routinely does — a
   * browser shares a page as a URL in `EXTRA_TEXT` with no stream at all.
   */
  fun absorb(context: Context, intent: Intent?): String? {
    if (intent == null) {
      return null
    }

    val action = intent.action

    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
      return null
    }

    val streams: List<Uri> =
      if (action == Intent.ACTION_SEND) {
        listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)
      } else {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.filterNotNull() ?: emptyList()
      }

    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()

    if (streams.isEmpty() && text.isEmpty()) {
      // A share with nothing in it. Clearing the action anyway, so that a
      // malformed intent is not re-examined on every foreground.
      intent.action = null

      return null
    }

    val identifier = UUID.randomUUID().toString().replace("-", "").lowercase(Locale.ROOT)
    val entry = File(outbox(context), identifier)

    if (!entry.mkdirs() && !entry.isDirectory) {
      return null
    }

    val items = JSONArray()
    val taken = mutableSetOf<String>()

    for (uri in streams.take(ITEM_LIMIT)) {
      copy(context, uri, entry, taken)?.let(items::put)
    }

    if (text.isNotEmpty() && items.length() < ITEM_LIMIT) {
      items.put(
        JSONObject().apply {
          // A shared page is a URL in `EXTRA_TEXT` and nothing else, which is by
          // far the commonest Android share there is. Saying which of the two it
          // is costs one check and is a distinction the app cannot recover
          // later from a string.
          put("kind", if (looksLikeUrl(text)) "url" else "text")
          put("text", text)
        }
      )
    }

    if (items.length() == 0) {
      entry.deleteRecursively()
      intent.action = null

      return null
    }

    val manifest =
      JSONObject().apply {
        put("version", VERSION)
        put("id", identifier)
        // No `bot`: Android has no sheet of ours in this flow. The app asks.
        put("note", "")
        put("createdAt", System.currentTimeMillis() / 1000)
        put("items", items)
      }

    // LAST, for the reason the Swift side states: the app skips a directory
    // with no readable manifest, so a process killed mid-copy leaves something
    // inert rather than something that claims files it does not have.
    return try {
      File(entry, MANIFEST).writeText(manifest.toString())
      intent.action = null
      identifier
    } catch (error: Exception) {
      entry.deleteRecursively()
      null
    }
  }

  /** Every entry waiting, as the map shape `src/platform/share-inbox.ts` expects. */
  fun list(context: Context): List<Map<String, Any>> {
    val directories = outbox(context).listFiles()?.filter { it.isDirectory } ?: return emptyList()
    val entries = mutableListOf<Map<String, Any>>()

    for (directory in directories) {
      val manifest = File(directory, MANIFEST)

      if (!manifest.isFile || manifest.length() <= 0 || manifest.length() > MAX_MANIFEST_BYTES) {
        continue
      }

      val json =
        try {
          manifest.readText()
        } catch (error: Exception) {
          continue
        }

      val files =
        (directory.listFiles() ?: emptyArray())
          .filter { it.isFile && it.name != MANIFEST && it.name != CLAIM }
          .associate { it.name to Uri.fromFile(it).toString() }

      val claimFile = File(directory, CLAIM)
      val entry = mutableMapOf<String, Any>("id" to directory.name, "manifest" to json, "files" to files)

      if (claimFile.isFile) {
        // An unreadable claim is still a claim: its existence is the load-bearing
        // fact, and `parseShareClaim` reads an empty string as one. Dropping it
        // would turn an ambiguous entry back into one the app sends unasked.
        entry["claim"] =
          if (claimFile.length() in 1..MAX_MANIFEST_BYTES) {
            try {
              claimFile.readText()
            } catch (error: Exception) {
              ""
            }
          } else {
            ""
          }
      }

      entries.add(entry)
    }

    return entries
  }

  /**
   * Delete one entry, by the name JavaScript answered with.
   *
   * Matched against the directory's own listing rather than joined onto the
   * outbox path, which makes the check total: an id carrying a separator or a
   * `..` simply matches nothing.
   */
  fun clear(context: Context, id: String): Boolean {
    val target = outbox(context).listFiles()?.firstOrNull { it.isDirectory && it.name == id } ?: return false

    return target.deleteRecursively()
  }

  /**
   * Copy one shared stream in, and answer its manifest item.
   *
   * The name comes from `OpenableColumns.DISPLAY_NAME` where the provider
   * offers one and from the URI's last segment where it does not, and it is
   * sanitised on the way rather than on the way out — the same rule
   * `isSafeShareFileName` applies on the other side, applied by the writer,
   * because a check made only by the reader is a check that was not made when
   * the bytes were written.
   */
  private fun copy(context: Context, uri: Uri, entry: File, taken: MutableSet<String>): JSONObject? {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri) ?: "application/octet-stream"
    var name = uri.lastPathSegment ?: "attachment"
    var size = 0L

    try {
      resolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)

          if (nameColumn >= 0 && !cursor.isNull(nameColumn)) {
            name = cursor.getString(nameColumn)
          }

          if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) {
            size = cursor.getLong(sizeColumn)
          }
        }
      }
    } catch (error: Exception) {
      // A provider that refuses to be queried still usually opens. The name
      // falls back to the URI's last segment, which is what it was before.
    }

    val safe = unique(sanitise(name), taken)
    val destination = File(entry, safe)

    try {
      resolver.openInputStream(uri)?.use { input ->
        destination.outputStream().use { output -> input.copyTo(output) }
      } ?: return null
    } catch (error: Exception) {
      destination.delete()

      // One attachment that could not be copied is one attachment fewer, not a
      // share that fails.
      return null
    }

    return JSONObject().apply {
      put("kind", if (mimeType.startsWith("image/")) "image" else "file")
      put("path", safe)
      put("filename", safe)
      put("size", if (size > 0) size else destination.length())
      put("mimeType", mimeType)
    }
  }

  /** The one-segment name rule, matching `HermieShareOutbox.safeFileName`. */
  private fun sanitise(name: String): String {
    val mapped = name.take(120).map { if (it.isLetterOrDigit() && it.code < 128 || it in "._-") it else '-' }
    val collapsed = StringBuilder()

    for (character in mapped) {
      if (character == '-' && collapsed.lastOrNull() == '-') {
        continue
      }

      collapsed.append(character)
    }

    val trimmed = collapsed.toString().trimStart('.', '-')

    return trimmed.ifEmpty { "attachment" }
  }

  /** Two photographs called `IMG_0001.jpg` are two different files. */
  private fun unique(name: String, taken: MutableSet<String>): String {
    if (taken.add(name)) {
      return name
    }

    val base = name.substringBeforeLast('.', name)
    val extension = name.substringAfterLast('.', "")
    var index = 2

    while (true) {
      val candidate = if (extension.isEmpty()) "$base-$index" else "$base-$index.$extension"

      if (taken.add(candidate)) {
        return candidate
      }

      index += 1
    }
  }

  /**
   * Whether shared text is a link.
   *
   * Deliberately crude: one token, an http(s) scheme. A browser shares exactly
   * that and everything else is prose. Anything cleverer would start guessing
   * at text that merely CONTAINS a URL, which is a different thing and one the
   * bot reads perfectly well as text.
   */
  private fun looksLikeUrl(text: String): Boolean =
    !text.contains(Regex("\\s")) && (text.startsWith("http://") || text.startsWith("https://"))
}
