/**
 * core/output-paths.ts
 * --------------------
 * Where every per-drive, per-type output file lives. One place, so the
 * commands that write a file and the commands that read it can't disagree.
 *
 * The top of `output/<drive>/<type>/` holds only what you open — the catalog
 * and the warnings files. Everything else sits one level down:
 *
 *   output/<drive>/<type>/
 *   ├── all-warnings.json           report — every command's warnings, merged
 *   ├── <type>.json                 catalog
 *   ├── warnings.json               scan
 *   ├── validation-warnings.json    validate
 *   ├── plex-warnings.json          plex:check
 *   ├── plex-log-warnings.json      plex:logs
 *   ├── data/                       detail other commands read
 *   │   ├── probe.json
 *   │   └── validation.json
 *   └── unfiltered/                 --no-ignore reviews
 */

import fs from 'fs'
import path from 'path'

export const DATA_DIR = 'data'
export const UNFILTERED_DIR = 'unfiltered'

/**
 * The folder the removed `fix:shows` command kept its rename plans and undo
 * manifests in. Only looked for, so the user hears it's no longer used.
 */
const FIXES_DIR = 'fixes'

/** The last commit that still had `fix:shows`, for replaying an old undo manifest. */
const LAST_FIX_SHOWS_COMMIT = '8e7515a'

export interface TypeOutputPaths {
  /** output/<drive>/<type>/ */
  dir: string
  /** The same folder relative to the project root, for console messages. */
  displayDir: string
  catalog: string
  warnings: string
  validationWarnings: string
  /** plex-warnings.json — written by plex:check. */
  plexWarnings: string
  /** plex-log-warnings.json — written by plex:logs. */
  plexLogWarnings: string
  /**
   * all-warnings.json — written by `npm run report`, which folds the four
   * files above into one entry per top-level folder. The only warnings file
   * that is read back rather than just written.
   */
  allWarnings: string
  /** data/probe.json — written by the scan, read by validate and plex:check. */
  probe: string
  /** data/validation.json — written by validate, read by plex:check. */
  validation: string
  /** unfiltered/ — `--no-ignore` copies of warnings files. */
  unfilteredDir: string
}

export function typeOutputPaths(
  projectRoot: string,
  driveSlug: string,
  mediaType: string
): TypeOutputPaths {
  const dir = path.join(projectRoot, 'output', driveSlug, mediaType)
  return {
    dir,
    displayDir: path.relative(projectRoot, dir).split(path.sep).join('/'),
    catalog: path.join(dir, `${mediaType}.json`),
    warnings: path.join(dir, 'warnings.json'),
    validationWarnings: path.join(dir, 'validation-warnings.json'),
    plexWarnings: path.join(dir, 'plex-warnings.json'),
    plexLogWarnings: path.join(dir, 'plex-log-warnings.json'),
    allWarnings: path.join(dir, 'all-warnings.json'),
    probe: path.join(dir, DATA_DIR, 'probe.json'),
    validation: path.join(dir, DATA_DIR, 'validation.json'),
    unfilteredDir: path.join(dir, UNFILTERED_DIR),
  }
}

// ─────────────────────────────────────────────
// Files from older versions
// ─────────────────────────────────────────────

/**
 * Files an older version wrote that nothing reads any more: the flat layout's
 * top-level data files, so a stale `probe.json` doesn't sit there looking
 * current, and the removed `fix:shows` command's `fixes/` folder and plans.
 */
export function findLegacyOutputFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      if (entry.isDirectory()) return entry.name === FIXES_DIR ? [`${FIXES_DIR}/`] : []
      const name = entry.name
      const legacy =
        name === 'probe.json' ||
        name === 'validation.json' ||
        name === 'rename-plan.json' ||
        /^rename-undo-.+\.json$/.test(name) ||
        name.endsWith('.unfiltered.json')
      return legacy ? [name] : []
    })
    .sort()
}

const reported = new Set<string>()

/**
 * Print a one-time note (per folder, per run) listing files from older
 * versions that are safe to delete. Never deletes anything itself — undo
 * manifests in particular may still be wanted.
 */
export function reportLegacyOutputFiles(paths: TypeOutputPaths): void {
  if (reported.has(paths.dir)) return
  reported.add(paths.dir)

  const legacy = findLegacyOutputFiles(paths.dir)
  if (legacy.length === 0) return

  console.log(
    `    [NOTE] ${paths.displayDir}/ has files from an older version that are no longer read: ${legacy.join(', ')}.`
  )
  console.log(
    `           Probe and validation data now live in ${DATA_DIR}/ and --no-ignore output in ${UNFILTERED_DIR}/.`
  )
  const undo = legacy.some(name => name === `${FIXES_DIR}/` || name.startsWith('rename-undo-'))
  console.log(
    undo
      ? `           fix:shows was removed; to replay a rename-undo-*.json, check out commit ${LAST_FIX_SHOWS_COMMIT}. Otherwise they are safe to delete.`
      : '           They are safe to delete.'
  )
}
