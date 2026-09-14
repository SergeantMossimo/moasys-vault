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
 * Only for files this project owns (under cache/ and output/). Never point it
 * at a media library path — see the read-only rule in CLAUDE.md.
 */

import fs from 'fs'
import path from 'path'

/** Windows can briefly lock a file an editor or antivirus is reading. */
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5

export function writeFileAtomic(filePath: string, contents: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, contents, typeof contents === 'string' ? 'utf-8' : undefined)

  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (LOCKED_CODES.has(code) && attempt < RENAME_ATTEMPTS) {
        // Short synchronous back-off; these locks clear in milliseconds.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt)
        continue
      }
      // Still locked: fall back to writing in place rather than losing the
      // data, then clean up the temp file.
      if (LOCKED_CODES.has(code)) {
        fs.writeFileSync(filePath, contents, typeof contents === 'string' ? 'utf-8' : undefined)
        fs.rmSync(tmp, { force: true })
        return
      }
      fs.rmSync(tmp, { force: true })
      throw err
    }
  }
}
