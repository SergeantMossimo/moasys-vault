/**
 * core/config.ts
 * --------------
 * Loader and Zod schema for `config.json`.
 *
 * Until now `config.json` was parsed with a bare `JSON.parse(...) as AppConfig`,
 * which means a missing field, a typo'd key, or an empty `root_path` would
 * blow up deep inside a media module with a confusing TypeError. This module
 * fixes that — same boot-time validation pattern we use for `.secrets.json`
 * and rules YAMLs.
 *
 * All four media types are required to match the existing registry-based
 * dispatch in `src/scan.ts`. If you have a library that doesn't include one
 * of the types, give it a placeholder root (it won't be touched unless you
 * run that media type's commands).
 *
 * Each media type is a LIST of named roots so a library can span drives:
 *
 *   "movies": [
 *     { "root_path": "M:\\Movies", "name": "Server" },
 *     { "root_path": "D:\\Movies", "name": "External" }
 *   ]
 *
 * A run always targets exactly one root — named positionally
 * (`npm run movies external`) or defaulting to the first entry.
 */

import fs from 'fs'
import path from 'path'

import { z } from 'zod'

import { AppConfig } from './types'

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────

/** Folder under output/ that holds Plex pulls. Reserved as a drive name. */
export const PLEX_OUTPUT_SEGMENT = 'plex'

/**
 * One named root. `root_path` is the per-machine location; `name` identifies
 * the drive and becomes a folder segment under cache/, ignored/, and output/,
 * so it's restricted to characters that are safe in a path on every platform.
 *
 * The regex allows dots (so `NAS.2` works) but `.` and `..` are rejected
 * outright: they're valid against the character class yet would resolve the
 * output folder somewhere other than where it belongs (`output/../movies`).
 * Path separators and colons are already excluded, so a name can never be
 * absolute or climb more than the one level this check blocks.
 */
const MediaRootSchema = z.object({
  root_path: z.string().min(1, 'root_path must be a non-empty string'),
  name: z
    .string()
    .min(1, 'name must be a non-empty string')
    .regex(
      /^[A-Za-z0-9._-]+$/,
      'name may only contain letters, numbers, dots, dashes, and underscores (it becomes a folder name)'
    )
    .refine(
      value => value !== '.' && value !== '..',
      "name cannot be '.' or '..' — it is used as a folder name"
    )
    // output/plex/ holds the Plex library pulls, which aren't tied to a drive.
    // A drive named "Plex" would write its scan output into the same folder.
    .refine(
      value => value.toLowerCase() !== PLEX_OUTPUT_SEGMENT,
      `name cannot be '${PLEX_OUTPUT_SEGMENT}' — output/${PLEX_OUTPUT_SEGMENT}/ is reserved for Plex library pulls`
    ),
})

/**
 * Plex connection settings. Optional — only the `plex:*` commands read it,
 * and they exit with setup instructions when it's missing. The token is NOT
 * here: it's a credential, so it lives in the gitignored `.secrets.json`.
 */
const PlexConfigSchema = z.object({
  /**
   * Base URL of the Plex Media Server, e.g. `http://192.168.1.50:32400`, or
   * the `https://…plex.direct:32400` address when the server requires
   * secure connections.
   */
  url: z
    .string()
    .url('plex.url must be a full URL, e.g. "http://192.168.1.50:32400"')
    .refine(u => /^https?:\/\//i.test(u), 'plex.url must start with http:// or https://'),
  /**
   * Explicit prefix translations from the paths Plex reports to the paths
   * this machine uses, for when automatic mapping can't work out the
   * relationship. `{ "plex": "/volume1/Media", "local": "M:\\" }` turns
   * `/volume1/Media/Movies/HD/…` into `M:\Movies\HD\…`.
   */
  path_map: z
    .array(
      z.object({
        plex: z.string().min(1),
        local: z.string().min(1),
      })
    )
    .optional(),
})

export type PlexConfig = z.infer<typeof PlexConfigSchema>

/**
 * A media type's list of roots: at least one, with unique names. Names are
 * compared case-insensitively because they resolve to folder names, and
 * Windows would silently collapse "Server" and "server" into one directory.
 */
const MediaRootListSchema = z
  .array(MediaRootSchema)
  .min(1, 'must list at least one root, e.g. [{ "root_path": "M:\\\\Movies", "name": "Server" }]')
  .superRefine((roots, ctx) => {
    const seen = new Map<string, number>()
    roots.forEach((root, i) => {
      const key = root.name.toLowerCase()
      const first = seen.get(key)
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `duplicate name '${root.name}' (already used at index ${first}); names must be unique per media type`,
        })
        return
      }
      seen.set(key, i)
    })
  })

/**
 * Full `config.json` schema.
 *
 * `_notes` is allowed for self-documentation (some config files use it for
 * inline comments since JSON has none) — the scanner ignores it.
 */
export const AppConfigSchema = z.object({
  _notes: z.record(z.string(), z.string()).optional(),
  movies: MediaRootListSchema,
  shows: MediaRootListSchema,
  music: MediaRootListSchema,
  audiobooks: MediaRootListSchema,
  plex: PlexConfigSchema.optional(),
})

// ─────────────────────────────────────────────
// Drive names
// ─────────────────────────────────────────────

/**
 * Convert a root's configured `name` into the folder segment used under
 * cache/, ignored/, and output/. Lowercased so `"Server"` and `"server"`
 * always resolve to the same directory regardless of how the user typed it
 * in config.json or on the command line.
 */
export function driveSlug(name: string): string {
  return name.toLowerCase()
}

// ─────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────

const MEDIA_TYPE_KEYS = ['movies', 'shows', 'music', 'audiobooks'] as const

const EXAMPLE_CONFIG = `    {
      "movies":     [{ "root_path": "M:\\\\Movies",     "name": "Server" },
                     { "root_path": "D:\\\\Movies",     "name": "External" }],
      "shows":      [{ "root_path": "M:\\\\Shows",      "name": "Server" }],
      "music":      [{ "root_path": "M:\\\\Audio",      "name": "Server" }],
      "audiobooks": [{ "root_path": "M:\\\\Audiobooks", "name": "Server" }]
    }`

/**
 * Detect the pre-multi-drive shape (`"movies": { "root_path": "..." }`) and
 * print a migration message instead of the generic Zod "expected array"
 * error, which doesn't tell the user what to actually do.
 *
 * Worth special-casing because the old single-root format also invited
 * duplicate `root_path` keys as a workaround — and `JSON.parse` silently
 * keeps only the last one, so a two-drive config appeared to work while
 * scanning just one drive.
 */
function reportLegacyShape(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return

  const record = raw as Record<string, unknown>
  const legacy = MEDIA_TYPE_KEYS.filter(key => {
    const section = record[key]
    return typeof section === 'object' && section !== null && !Array.isArray(section)
  })
  if (legacy.length === 0) return

  console.error('\n  Error: config.json uses the old single-root format.')
  console.error(`  Each media type is now a LIST of named roots (${legacy.join(', ')}).`)
  console.error('  Rewrite it like this:')
  console.error(EXAMPLE_CONFIG)
  console.error('\n  Each `name` becomes a folder under cache/, ignored/, and output/,')
  console.error('  and is how you select a drive: `npm run movies external`.')
  process.exit(1)
}

/**
 * Load and validate `config.json`. On any failure (missing file, malformed
 * JSON, schema mismatch) print a targeted message and exit cleanly.
 *
 * The function returns the same `AppConfig` shape the rest of the code
 * already expects, so callers swap `JSON.parse(...) as AppConfig` for
 * `loadConfig(projectRoot)` with no other changes.
 */
export function loadConfig(projectRoot: string): AppConfig {
  const configPath = path.join(projectRoot, 'config.json')

  if (!fs.existsSync(configPath)) {
    console.error(`\n  Error: config.json not found at ${configPath}`)
    console.error('  Create it with one or more named roots per media type. Minimal example:')
    console.error(EXAMPLE_CONFIG)
    process.exit(1)
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (err) {
    console.error(`\n  Error parsing config.json: ${(err as Error).message}`)
    process.exit(1)
  }

  reportLegacyShape(raw)

  const parsed = AppConfigSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('\n  Error: config.json failed schema validation:')
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      console.error(`    - ${where}: ${issue.message}`)
    }
    process.exit(1)
  }

  return parsed.data
}
