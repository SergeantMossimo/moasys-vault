/**
 * core/atomic-write.ts
 * --------------------
 * Write a project file (cache, output) so a crash or Ctrl+C mid-write can
 * never leave it truncated.
 *
 * The contents go to a temporary file beside the target, then a rename swaps
 * it into place. Readers see either the old file or the new one, never half
 * of each. This matters most for the probe cache: a corrupt cache loads as
 * empty, and rebuilding it means re-probing the whole library.
 *
 * Only for files this project owns. Every file the app writes goes through
 * here, and `assertProjectPath` refuses anything outside the project folder —
 * so the read-only rule in CLAUDE.md (never write to a media library) is
 * enforced by the code, not just by convention.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

import { PROJECT_ROOT } from './project'

/** Windows can briefly lock a file an editor or antivirus is reading. */
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5

/**
 * Folders the app may write under: the project itself, and the OS temp
 * folder the test suite builds its fixture projects in.
 */
const WRITABLE_ROOTS = [PROJECT_ROOT, os.tmpdir()].map(root => path.resolve(root).toLowerCase())

/** Throw unless `filePath` sits inside one of `WRITABLE_ROOTS`. */
export function assertProjectPath(filePath: string): void {
  const target = path.resolve(filePath).toLowerCase()
  const inside = WRITABLE_ROOTS.some(root => {
    const rel = path.relative(root, target)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
  if (!inside) {
    throw new Error(
      `Refusing to write ${filePath}: outside the project folder. MOASYS-Vault never writes to a media library.`
    )
  }
}

const encodingOf = (contents: string | Uint8Array) =>
  typeof contents === 'string' ? 'utf-8' : undefined

export function writeFileAtomic(filePath: string, contents: string | Uint8Array): void {
  assertProjectPath(filePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, contents, encodingOf(contents))

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (!LOCKED_CODES.has(code)) throw err
        if (attempt < RENAME_ATTEMPTS) {
          // Short synchronous back-off; these locks clear in milliseconds.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt)
          continue
        }
        // Still locked: fall back to writing in place rather than losing the data.
        fs.writeFileSync(filePath, contents, encodingOf(contents))
        return
      }
    }
  } finally {
    // Gone after a successful rename; otherwise never leave it behind.
    fs.rmSync(tmp, { force: true })
  }
}
