/**
 * validate/secrets.ts
 * -------------------
 * Loader for `.secrets.json` at the project root. Holds API keys and other
 * sensitive values that must never be committed.
 *
 * Every integration's block is optional in the file — someone who only uses
 * TMDB shouldn't need a Plex token, and vice versa. Callers name the
 * integration they need, and a missing or malformed block for THAT
 * integration fails with a clear, actionable message before any requests
 * fire.
 */

import fs from 'fs'
import path from 'path'

import { z } from 'zod'

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────

/** The Movie Database. https://www.themoviedb.org/settings/api */
const TmdbSecretsSchema = z.object({
  /** v3 API key. NOT the v4 bearer token. */
  api_key: z
    .string()
    .min(20, 'api_key looks too short — paste the full TMDB v3 key')
    // Reject the placeholder string from .secrets.json.example so users
    // can't accidentally try to run with the unedited template.
    .refine(s => !s.includes('PASTE-YOUR'), {
      message:
        'api_key is still the .secrets.json.example placeholder — paste your real TMDB API key',
    }),
})

/** Plex Media Server. */
const PlexSecretsSchema = z.object({
  /**
   * An `X-Plex-Token`. Downloading server logs needs the server OWNER's
   * token; everything else works with any token that can see the libraries.
   */
  token: z
    .string()
    .min(10, 'token looks too short — paste the full X-Plex-Token value')
    .refine(s => !s.includes('PASTE-YOUR'), {
      message: 'token is still the .secrets.json.example placeholder — paste your real Plex token',
    }),
})

/**
 * `.secrets.json` shape.
 * Extend this schema whenever a new external integration needs credentials.
 */
export const SecretsSchema = z.object({
  /** Optional documentation block — ignored by the loader. */
  _notes: z.record(z.string(), z.unknown()).optional(),
  tmdb: TmdbSecretsSchema.optional(),
  plex: PlexSecretsSchema.optional(),
})

export type Secrets = z.infer<typeof SecretsSchema>
export type Integration = 'tmdb' | 'plex'

/** How to get each integration's credential, for the missing-block message. */
const SETUP_HINTS: Record<Integration, string[]> = {
  tmdb: [
    'Add your TMDB v3 API key as  "tmdb": { "api_key": "..." }',
    'Get a free key at: https://www.themoviedb.org/settings/api',
  ],
  plex: [
    'Add your Plex token as  "plex": { "token": "..." }',
    'To find it: in Plex Web open any item → ⋯ → Get Info → View XML.',
    'The token is the X-Plex-Token value at the end of the page URL.',
  ],
}

// ─────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────

/**
 * Load and validate `.secrets.json`, returning the block for `integration`.
 *
 * On any failure (missing file, invalid JSON, schema mismatch, or no block
 * for the integration) print a targeted message that tells the user how to
 * fix it and exit. This is the only place where missing credentials should
 * produce errors — every downstream caller assumes it got valid secrets.
 */
export function loadSecrets(projectRoot: string, integration: 'tmdb'): NonNullable<Secrets['tmdb']>
export function loadSecrets(projectRoot: string, integration: 'plex'): NonNullable<Secrets['plex']>
export function loadSecrets(
  projectRoot: string,
  integration: Integration
): NonNullable<Secrets[Integration]> {
  const secretsPath = path.join(projectRoot, '.secrets.json')
  const examplePath = path.join(projectRoot, '.secrets.json.example')

  if (!fs.existsSync(secretsPath)) {
    console.error('\n  Error: .secrets.json not found at project root.')
    console.error(`    Expected at: ${secretsPath}`)
    console.error('  ')
    console.error(`    Copy ${path.basename(examplePath)} to .secrets.json, then:`)
    for (const line of SETUP_HINTS[integration]) console.error(`    ${line}`)
    process.exit(1)
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'))
  } catch (err) {
    console.error(`\n  Error parsing .secrets.json: ${(err as Error).message}`)
    process.exit(1)
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('\n  Error: .secrets.json must be a JSON object.')
    process.exit(1)
  }

  const blockRaw = (raw as Record<string, unknown>)[integration]
  if (blockRaw === undefined) {
    console.error(`\n  Error: .secrets.json has no "${integration}" block.`)
    for (const line of SETUP_HINTS[integration]) console.error(`    ${line}`)
    process.exit(1)
  }

  // Validate only the block this command needs. A user who runs only Plex
  // commands may still have the example's unedited TMDB placeholder in the
  // file, and that must not block them.
  const schema = SecretsSchema.shape[integration].unwrap()
  const parsed = schema.safeParse(blockRaw)
  if (!parsed.success) {
    console.error('\n  Error: .secrets.json failed schema validation:')
    for (const issue of parsed.error.issues) {
      const where = [integration, ...issue.path].join('.')
      console.error(`    - ${where}: ${issue.message}`)
    }
    process.exit(1)
  }
  return parsed.data
}
