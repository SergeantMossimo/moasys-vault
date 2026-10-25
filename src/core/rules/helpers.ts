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
const RegexString = z.string().refine(
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
 * `flags` is validated against the set of letters JavaScript accepts, so a typo
 * like `flags: 'x'` fails at boot instead of throwing inside RegExp. `g` and
 * `y` are refused too: they make a RegExp remember where its last match ended
 * (`lastIndex`), and every compiled pattern is reused across thousands of
 * names, so every other folder would silently fail to match.
 */
export const PatternSchema = z.preprocess(
  v => (typeof v === 'string' ? { pattern: v, flags: '' } : v),
  z.object({
    pattern: RegexString,
    flags: z
      .string()
      .regex(/^[dimsu]*$/, {
        message:
          'flags must be a combination of d, i, m, s, u (g and y are not allowed — patterns are reused for every name)',
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

/** The label records get when `categories` is empty and `root_path` is walked directly. */
export const DEFAULT_CATEGORY = 'default'

/**
 * One entry in the `categories` rules array — a subfolder under root_path
 * that the scanner walks. The `name` is the folder name on disk AND the
 * label used in output (`category` field on each version).
 *
 * Leaving `categories` empty (or unset) is supported — the scanner falls
 * back to walking `root_path` directly and labelling records with
 * `DEFAULT_CATEGORY`, which is why no real category may use that name.
 */
export const CategorySchema = z.object({
  /** Subfolder name on disk under root_path, e.g. "UHD". Also used as the output label. */
  name: z
    .string()
    .min(1)
    .refine(
      name => name.toLowerCase() !== DEFAULT_CATEGORY,
      `'${DEFAULT_CATEGORY}' is reserved for a library with no categories — rename the folder or leave categories empty`
    ),
})

export type Category = z.infer<typeof CategorySchema>

/**
 * A type's `categories` list. Names must be unique, compared case-insensitively
 * because Windows folder names are: `HD` and `hd` are the same folder, and
 * listing it twice would scan it twice and report every title in it as a
 * duplicate of itself.
 */
export const CategoryListSchema = z.array(CategorySchema).superRefine((cats, ctx) => {
  const seen = new Set<string>()
  cats.forEach((cat, i) => {
    const key = cat.name.toLowerCase()
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'name'],
        message: `duplicate category '${cat.name}' — each folder may be listed once`,
      })
    }
    seen.add(key)
  })
})

/**
 * Whether a category label names a real folder. `DEFAULT_CATEGORY` stands for
 * `root_path` itself, so it never appears in a path or an ignore scope.
 */
export function isRealCategory(category: string | undefined): category is string {
  return category !== undefined && category !== '' && category !== DEFAULT_CATEGORY
}

/**
 * A forward-slash warning path under a category — `Category/a/b` — or just
 * `a/b` in a library with no categories.
 */
export function categoryPath(category: string | undefined, ...segments: string[]): string {
  return (isRealCategory(category) ? [category, ...segments] : segments).join('/')
}

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
const KNOWN_QUALITIES = ['UHD', 'HD', 'SD'] as const

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
    return [{ folderName: '', name: DEFAULT_CATEGORY, quality: null }]
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
 * Return true if a set of values — quality tiers, categories, or codecs —
 * matches one of the acceptable combos from the rules. Set-based: order inside
 * a combo doesn't matter, but the sizes must match exactly, so `[UHD, HD]`
 * accepts `{UHD, HD}` and nothing wider.
 *
 * Quality combos describe which tiers may legitimately coexist — they say
 * nothing about how many copies live inside one tier, which is why
 * `warn_duplicate_quality` deliberately ignores them.
 */
export function isAcceptableCombo(values: Set<string>, combos: readonly string[][]): boolean {
  return combos.some(combo => combo.length === values.size && combo.every(v => values.has(v)))
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
 * Shared by `warn_episode_code_case` in media/shows.ts and the episode-level
 * ignore matching in core/ignored.ts, so the two can never disagree about
 * what "canonical" means.
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
 * A show filename stem that follows the convention except for how its
 * season/episode code is written: numbers that aren't zero-padded
 * ('Shameless (2011) - s02e4'), an over-padded season ('Cheers (1982) -
 * S010e01'), or a missing space around the separator ('Diners, Drive-Ins And
 * Dives (2006) -S01e01'). The rules' `patterns.file` rejects these, so they
 * surface as warn_bad_file_name; this pattern is what lets that warning point
 * at the `episode-code` fix, and what lets that fix mode parse the file in
 * order to rewrite the code into canonical form.
 *
 * Same named groups as the default `patterns.file`, so it can stand in for it.
 */
export const LENIENT_EPISODE_FILE =
  /^(?<title>.+)\s\((?<year>\d{4})\)\s?-\s?S(?<season>\d{1,3})E(?<episode>\d{1,3})(?:-E?(?<episode_end>\d{1,3}))?(?:\s-\s(?<episode_title>.+))?$/i

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
  return /^\s-\s(S\d{2}E\d{2,3}(?:-E?\d{2,3})?)/i.exec(afterYear)?.[1] ?? null
}
