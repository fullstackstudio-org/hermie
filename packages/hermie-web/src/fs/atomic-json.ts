/**
 * Writing one of the service's JSON state files, safely and in order.
 *
 * `admin.json` and `oidc.json` are both rewritten whole, from a snapshot held in
 * memory, and both used to be written through one fixed temp name per process
 * with nothing ordering the writes. Two overlapping writes could then land in
 * either order, or trip over each other's temp file, and the older snapshot
 * landing last silently undid whatever the newer one changed. This is the one
 * place that rule now lives:
 *
 *  - **One chain per file.** Every write of the same resolved path waits for
 *    the one asked for before it, so writes reach disk in call order and the
 *    last one asked for is the one that stays.
 *  - **A temp name per write** (pid, a counter and a random suffix), then an
 *    atomic rename. No two writes share a temp file, in this process or beside
 *    another one, and a write that fails removes its own.
 *  - **A failure stops nothing else.** The chain's stored tail never rejects;
 *    only the caller whose write failed hears about it.
 *  - `0600` on the file, `0700` on the directory, as every state file has.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The write still in flight for each file, by resolved path. */
const pendingWrites = new Map<string, Promise<void>>()
let writeSequence = 0

async function writeNow(file: string, body: string): Promise<void> {
  const dir = path.dirname(file)

  await mkdir(dir, { recursive: true, mode: 0o700 })
  // `mkdir`'s mode only applies on create, so a directory that existed with
  // wider permissions is narrowed here — the same thing `savePushState` does.
  await chmod(dir, 0o700).catch(() => undefined)

  writeSequence += 1
  const temporary = `${file}.${process.pid}.${writeSequence}.${randomBytes(4).toString('hex')}.tmp`

  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    // `writeFile`'s mode is filtered through the umask; say it outright.
    await chmod(temporary, 0o600).catch(() => undefined)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * Write `value` as pretty JSON to `file`, after every write of the same file
 * asked for before it.
 *
 * The value is serialised NOW, at the call, so what lands is what the caller
 * held when it asked — not whatever the object looks like by the time the
 * chain reaches it. The returned promise rejects if THIS write failed; the
 * chain carries on regardless.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const target = path.resolve(file)
  const body = `${JSON.stringify(value, null, 2)}\n`
  const previous = pendingWrites.get(target) ?? Promise.resolve()
  const write = previous.then(() => writeNow(target, body))
  const tail = write.catch(() => undefined)

  pendingWrites.set(target, tail)
  void tail.then(() => {
    if (pendingWrites.get(target) === tail) {
      pendingWrites.delete(target)
    }
  })

  return write
}

/**
 * Resolves once every write of `file` asked for so far has finished, whether
 * it succeeded or not. For a caller that fired a write without awaiting it and
 * now needs the file to say what memory says.
 */
export function jsonWritesSettled(file: string): Promise<void> {
  return pendingWrites.get(path.resolve(file)) ?? Promise.resolve()
}
