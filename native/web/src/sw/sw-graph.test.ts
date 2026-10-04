// @vitest-environment node
/**
 * The service worker is built as a second entry and registered as a classic
 * script (`vite.config.ts`): it must import nothing at run time. Two rules keep
 * Rollup from splitting a shared chunk out of it, and they are held here from the
 * sources: `src/sw` imports only from `src/sw` (and only types from anywhere
 * else), and nothing outside `src/sw` imports from it. The few constants the page
 * and the worker both need are written twice, and held equal here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as page from '../core/push/actions'
import * as worker from './notification'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'generated' ? [] : sources(path)
    }

    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

/** Every relative module a file imports at run time (a type-only import is erased). */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []

  for (const match of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/gmu)) {
    if (!match[2] && match[3]?.startsWith('.')) {
      found.push(resolve(dirname(file), match[3]))
    }
  }

  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu)) {
    if (match[1]?.startsWith('.')) {
      found.push(resolve(dirname(file), match[1]))
    }
  }

  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    if (match[1]?.startsWith('.')) {
      found.push(resolve(dirname(file), match[1]))
    }
  }

  return found
}

const inWorker = (path: string): boolean => !relative(here, path).startsWith('..')

describe('the service worker’s module graph', () => {
  it('imports nothing from outside src/sw at run time', () => {
    // The reader of imports reads them: the worker's own entry imports its module.
    expect(runtimeImports(join(here, 'sw.ts'))).toEqual([join(here, 'worker')])
    expect(runtimeImports(join(here, '..', 'core', 'push', 'sync.ts'))).toContain(join(src, 'core', 'push', 'actions'))

    for (const file of sources(here)) {
      for (const target of runtimeImports(file)) {
        expect(inWorker(target), `${relative(src, file)} imports ${relative(src, target)}`).toBe(true)
      }
    }
  })

  it('is imported by nothing outside src/sw', () => {
    for (const file of sources(src).filter(path => !inWorker(path))) {
      for (const target of runtimeImports(file)) {
        expect(inWorker(target), `${relative(src, file)} imports ${relative(src, target)}`).toBe(false)
      }
    }
  })

  it('says the same action ids, message source and launch parameter as the page', () => {
    expect(worker.PUSH_ACTION_ALLOW).toBe(page.PUSH_ACTION_ALLOW)
    expect(worker.PUSH_ACTION_DENY).toBe(page.PUSH_ACTION_DENY)
    expect(worker.PUSH_MESSAGE_SOURCE).toBe(page.PUSH_MESSAGE_SOURCE)
    expect(worker.PUSH_LAUNCH_PARAM).toBe(page.PUSH_LAUNCH_PARAM)
  })
})
