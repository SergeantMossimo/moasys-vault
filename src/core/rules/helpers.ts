/**
 * core/rules/helpers.ts
 * ---------------------
 * Shared Zod building blocks used by every per-media-type rules schema.
 *
 * `PatternSchema` is the important bit: it accepts either a plain string or
 * a `{ pattern, flags }` object in the YAML, and normalizes both into the
 * object form so the runtime code never has to branch.
 *
 * Why this exists:
 *   JavaScript regex does NOT support inline flag groups like (?i)...
 *   so case-insensitive patterns must pass flags through the constructor.
 *   Users who don't need flags shouldn't have to write the object form.
 */

import { z } from 'zod'

/** String that must compile as a JavaScript regular expression. */
export const RegexString = z.string().refine(
  s => {
    try {
      new RegExp(s)
      return true
    } catch {
      return false
    }
  },
  { message: 'must be a valid regular expression' }
)

/**
 * A pattern in the rules YAML. Either:
 *   - a plain string:  `folder: '^(?<title>.+)\s\((?<year>\d{4})\)$'`
 *   - or an object:    `folder: { pattern: '...', flags: 'i' }`
 *
 * After parsing, the value is always `{ pattern, flags }` with `flags`
 * defaulting to `''` — so callsites can just do `new RegExp(p.pattern, p.flags)`.
 *
 * `flags` is validated against the set of letters JavaScript actually accepts
 * so a typo like `flags: 'x'` fails at boot instead of throwing inside RegExp.
 */
export const PatternSchema = z.preprocess(
  v => (typeof v === 'string' ? { pattern: v, flags: '' } : v),
  z.object({
    pattern: RegexString,
    flags: z
      .string()
      .regex(/^[dgimsuy]*$/, {
        message:
          'flags must be a combination of JavaScript regex flag letters (d, g, i, m, s, u, y)',
      })
      .default(''),
  })
)

/** Inferred type for a normalized pattern entry. */
export type Pattern = z.infer<typeof PatternSchema>

/** Compile a Pattern into a RegExp. Convenience for factories. */
export function compilePattern(p: Pattern): RegExp {
  return new RegExp(p.pattern, p.flags)
}

/**
 * One entry in the `categories` rules array — a subfolder under root_path
 * that the scanner walks. The `name` is the folder name on disk AND the
 * label used in output (`category` field on each version).
 *
 * Leaving `categories` empty (or unset) is supported — the scanner falls
 * back to walking `root_path` directly and labelling records with `"default"`.
 */
export const CategorySchema = z.object({
  /** Subfolder name on disk under root_path, e.g. "UHD". Also used as the output label. */
  name: z.string().min(1),
})

export type Category = z.infer<typeof CategorySchema>

/**
 * Resolved internal form of a category — separates "what subfolder to walk"
 * from "what label to put on records." For configured categories these are
 * the same; for the synthetic root-walk case they differ ('' vs 'default').
 *
 * `quality` is auto-detected from the category name via the `UHD`/`HD`/`SD`
 * vocabulary; null when no whole-word match is found. Movies and shows use
 * this field for the quality-mismatch check and the multi-quality duplicate
 * check; music and audiobooks ignore it.
 */
export interface ResolvedCategory {
  /** Subfolder under root_path to walk; empty string means walk root_path itself. */
  folderName: string
  /** Label used in output records (the version's `category` field). */
  name: string
  /** Auto-detected quality keyword (UHD/HD/SD), or null for general-tag categories. */
  quality: string | null
}

/**
 * The canonical quality vocabulary that `detectQuality` looks for in category
 * names. Ordered UHD-first so a substring like "Other UHD" matches UHD rather
 * than the contained "HD".
 *
 * This is hardcoded for now. If a future use case needs additional keywords
 * (`4K`, `BluRay`, `DVD`, etc.), lift it into a configurable `quality_keywords`
 * field on the rules schema; until then, keeping it constant means the
 * detection rule is dead-simple to document and reason about.
 */
export const KNOWN_QUALITIES = ['UHD', 'HD', 'SD'] as const

/**
 * Sort an iterable of quality strings into a canonical order. Known qualities
 * (UHD/HD/SD) sort first in best-to-worst order; anything outside the
 * vocabulary lands after them in alphabetical order.
 */
export function sortQualities(qualities: Iterable<string>): string[] {
  return [...qualities].sort((a, b) => {
    const ia = (KNOWN_QUALITIES as readonly string[]).indexOf(a)
    const ib = (KNOWN_QUALITIES as readonly string[]).indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

/**
 * A sortable string that orders qualities the way `sortQualities` does —
 * known qualities in UHD → HD → SD order first, anything outside the
 * vocabulary alphabetically after them.
 *
 * Handed to `WarningCollector.add` as a `sortKey` so a warning bucket groups
 * by quality instead of by path: every UHD row, then every HD row, then every
 * SD row, alphabetical by title within each. The rank is zero-padded so the
 * string comparison stays correct if `KNOWN_QUALITIES` ever grows past ten.
 */
export function qualitySortKey(quality: string): string {
  const i = (KNOWN_QUALITIES as readonly string[]).indexOf(quality)
  const rank = i === -1 ? KNOWN_QUALITIES.length : i
  return `${String(rank).padStart(2, '0')}|${quality}`
}

/**
 * Auto-detect a quality keyword from a category name. Uses whole-word,
 * case-insensitive matching so:
 *   - "UHD" / "Other UHD" / "Director's Cut UHD"  → "UHD"
 *   - "HD" / "Other HD"                            → "HD"
 *   - "SD" / "Other SD"                            → "SD"
 *   - "USD" / "Standard" / "Documentary"           → null (no whole-word match)
 *
 * UHD is checked first so the "HD" inside "UHD" doesn't false-positive.
 */
export function detectQuality(categoryName: string): string | null {
  for (const q of KNOWN_QUALITIES) {
    if (new RegExp(`\\b${q}\\b`, 'i').test(categoryName)) return q
  }
  return null
}

/**
 * Resolve the effective category list for a media module.
 * If the rules supplied any categories, walk those. Otherwise return a single
 * synthetic entry that walks root_path and labels records "default".
 *
 * Each resolved entry includes a `quality` field — auto-detected via
 * `detectQuality` from the category name. Music/audiobook category names
 * (Music, Soundtracks, Audible, Book On CD, etc.) won't match the vocabulary
 * so they get `quality: null` and are treated as general tags.
 */
export function resolveCategories(configured: Category[]): ResolvedCategory[] {
  if (configured.length === 0) {
    return [{ folderName: '', name: 'default', quality: null }]
  }
  return configured.map(c => ({
    folderName: c.name,
    name: c.name,
    quality: detectQuality(c.name),
  }))
}

/**
 * Map each category name to the quality tier it belongs to. Categories whose
 * name carries no quality keyword map to their own name, so a general-tag
 * library ("Kids", "Documentaries") gets one tier per tag rather than all of
 * them collapsing into a single null bucket.
 *
 * Built once per media module at boot and handed to `groupCategoriesByQuality`
 * (core/versions.ts) by the multi-quality and duplicate-quality checks.
 */
export function buildCategoryQualityMap(cats: ResolvedCategory[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of cats) {
    out.set(c.name, c.quality ?? c.name)
  }
  return out
}

/**
 * Return true if the quality set matches one of the acceptable combos.
 * Set-based: order inside a combo doesn't matter, but the sizes must match
 * exactly, so `[UHD, HD]` accepts `{UHD, HD}` and nothing wider.
 *
 * Combos describe which quality tiers may legitimately coexist — they say
 * nothing about how many copies live inside one tier, which is why
 * `warn_duplicate_quality` deliberately ignores them.
 */
export function isAcceptableCombo(qualities: Set<string>, combos: readonly string[][]): boolean {
  return combos.some(combo => combo.length === qualities.size && combo.every(q => qualities.has(q)))
}

// ─────────────────────────────────────────────
// Episode code formatting (shows)
// ─────────────────────────────────────────────

/**
 * Build the canonical season/episode code for a show file: the configured
 * letter case, two-digit zero-padded numbers, and an explicit letter on the
 * multi-episode suffix (`s01e01-e02`, never the bare `s01e01-02`, which reads
 * as a range of two different things depending on who's looking).
 *
 * Shared by `warn_episode_code_case` in media/shows.ts and the `episode-code`
 * fix mode in tools/rename-shows.ts, so the warning and the fix can never
 * disagree about what "canonical" means.
 */
export function canonicalEpisodeCode(
  parts: { seasonNumber: number; episodeStart: number; episodeEnd: number },
  style: 'lower' | 'upper'
): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const [s, e] = style === 'lower' ? ['s', 'e'] : ['S', 'E']
  const base = `${s}${pad(parts.seasonNumber)}${e}${pad(parts.episodeStart)}`
  return parts.episodeEnd > parts.episodeStart ? `${base}-${e}${pad(parts.episodeEnd)}` : base
}

/**
 * Pull the season/episode code out of a filename stem as RAW TEXT, so callers
 * can compare the casing the user actually wrote rather than a value that has
 * already been normalized by parsing it into integers.
 *
 * Anchored on the `(<year>)` that precedes it, which keeps it correct for
 * shows whose own title contains a " - S.." sequence. Returns null when the
 * stem doesn't carry a recognizable code.
 */
export function extractEpisodeCode(stem: string, year: number): string | null {
  const marker = `(${year})`
  const markerIndex = stem.indexOf(marker)
  if (markerIndex === -1) return null
  const afterYear = stem.slice(markerIndex + marker.length)
  return /^\s-\s(S\d{2}E\d{2}(?:-E?\d{2})?)/i.exec(afterYear)?.[1] ?? null
}
