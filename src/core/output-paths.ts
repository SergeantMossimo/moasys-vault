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
 *   ├── fixes/                      fix:shows plans + undo manifests
 *   └── unfiltered/                 --no-ignore reviews
 */

import fs from 'fs'
import path from 'path'

export const DATA_DIR = 'data'
export const FIXES_DIR = 'fixes'
export const UNFILTERED_DIR = 'unfiltered'

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
  /** data/validation.json — written by validate, read by plex:check and fix:shows. */
  validation: string
  /** fixes/ — rename-plan.json and rename-undo-<timestamp>.json. */
  fixesDir: string
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
    fixesDir: path.join(dir, FIXES_DIR),
    unfilteredDir: path.join(dir, UNFILTERED_DIR),
  }
}

// ─────────────────────────────────────────────
// Files from the old flat layout
// ─────────────────────────────────────────────

/**
 * Files an older version wrote at the top of the type folder, before the
 * subfolders existed. Nothing reads them any more, so a stale `probe.json`
 * would otherwise sit there looking current.
 */
export function findLegacyOutputFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(
      name =>
        name === 'probe.json' ||
        name === 'validation.json' ||
        name === 'rename-plan.json' ||
        /^rename-undo-.+\.json$/.test(name) ||
        name.endsWith('.unfiltered.json')
    )
    .sort()
}

const reported = new Set<string>()

/**
 * Print a one-time note (per folder, per run) listing old-layout files that
 * are safe to delete. Never deletes anything itself — undo manifests in
 * particular may still be wanted.
 */
export function reportLegacyOutputFiles(paths: TypeOutputPaths): void {
  if (reported.has(paths.dir)) return
  reported.add(paths.dir)

  const legacy = findLegacyOutputFiles(paths.dir)
  if (legacy.length === 0) return

  console.log(
    `    [NOTE] ${paths.displayDir}/ has files from the old layout that are no longer read: ${legacy.join(', ')}.`
  )
  console.log(
    `           Probe and validation data now live in ${DATA_DIR}/, fix:shows files in ${FIXES_DIR}/, and --no-ignore output in ${UNFILTERED_DIR}/.`
  )
  const undo = legacy.some(name => name.startsWith('rename-undo-'))
  console.log(
    undo
      ? `           Delete the rest; keep any rename-undo-*.json you may still need (move it into ${FIXES_DIR}/ if you like — --undo takes any path).`
      : '           They are safe to delete.'
  )
}
