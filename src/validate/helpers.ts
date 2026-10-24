/**
 * validate/helpers.ts
 * -------------------
 * Shared helpers used by both movies and shows validation.
 *
 * `stripFilenameIllegalChars` lives in core/files.ts because the music
 * tag-matching path also depends on it. Re-exported here so existing
 * validate-side callsites keep working.
 */

import { stripFilenameIllegalChars } from '../core/files'
import { isRealCategory } from '../core/rules/helpers'

import { JsonCache } from './cache'
import { TmdbAbortError } from './tmdb'
import { ResolvedSearch, SearchCandidate } from './types'

export { stripFilenameIllegalChars }

// ─────────────────────────────────────────────
// TMDB lookups
// ─────────────────────────────────────────────

/**
 * How long a cached no-match or low-confidence verdict stands before TMDB is
 * asked again. Those verdicts are never final — TMDB's search index changes
 * ("Face/Off" simply wasn't returned for "FaceOff" when this library was
 * first validated, and stayed a false no-match because nothing re-asked) — but
 * re-asking every run cost hundreds of requests for the same answer.
 * Confident matches stay cached until `--refresh-older-than`.
 */
export const RECHECK_WARNED_AFTER_DAYS = 7

/**
 * Settle which TMDB entry a movie or show is, in order of authority:
 *
 *   1. a `{tmdb-N}` tag on the folder or file — how a user pins a title the
 *      search keeps getting wrong, so the search and its cache are skipped;
 *   2. a cached verdict — confident ones always, warned ones while fresh;
 *   3. a search, whose verdict is cached.
 *
 * When the search fails, the previous verdict stands rather than a no-match
 * TMDB never gave; with none, returns null and the title is left out of this
 * run. `TmdbAbortError` propagates — the run is over.
 */
export async function resolveSearch(
  key: string,
  taggedId: number | null,
  cache: JsonCache<ResolvedSearch>,
  search: () => Promise<ResolvedSearch>,
  label: string
): Promise<{ resolved: ResolvedSearch; cached: boolean } | null> {
  if (taggedId !== null) {
    return { resolved: { best_id: taggedId, confidence: 'high', candidates: [] }, cached: true }
  }
  const previous = cache.get(key)
  const confident = previous?.confidence === 'high' || previous?.confidence === 'medium'
  if (previous && (confident || cache.fetchedWithin(key, RECHECK_WARNED_AFTER_DAYS))) {
    return { resolved: previous, cached: true }
  }
  try {
    const resolved = await search()
    cache.set(key, resolved)
    return { resolved, cached: false }
  } catch (err) {
    if (err instanceof TmdbAbortError) throw err
    console.error(`    [TMDB] Search failed for ${label}: ${(err as Error).message}`)
    return previous ? { resolved: previous, cached: true } : null
  }
}

/**
 * The other candidates a search turned up, for a row's `alternatives` and the
 * low-confidence warning. `fromDetails` names an id cached before candidates
 * carried titles; one it can't name is left out.
 */
export function alternativesOf(
  resolved: ResolvedSearch,
  fromDetails: (id: number) => SearchCandidate | null
): SearchCandidate[] {
  const out: SearchCandidate[] = []
  for (const c of resolved.candidates) {
    const id = typeof c === 'number' ? c : c.id
    if (id === resolved.best_id) continue
    const alt = typeof c === 'number' ? fromDetails(c) : c
    if (alt) out.push(alt)
  }
  return out
}

/**
 * The low-confidence guess, named as well as the data allows — its details
 * fetch can fail, leaving only the id.
 */
export function guessText(title: string | null, year: number | null, id: number | null): string {
  if (title === null) return `Best TMDB guess is id ${id}`
  return year === null ? `Best TMDB guess is '${title}'` : `Best TMDB guess is '${title}' (${year})`
}

/**
 * A cached TMDB record, fetched and cached on a miss. A failed fetch is
 * logged and returns undefined — the checks that need it are skipped for
 * this title. `TmdbAbortError` propagates.
 *
 * `isComplete` turns a cached entry missing fields added since it was cached
 * into a miss, so it's re-fetched once instead of the whole cache being
 * discarded by a version bump. If that re-fetch fails, the old entry is used.
 */
export async function cachedFetch<T>(
  cache: JsonCache<T>,
  key: string,
  fetch: () => Promise<T>,
  label: string,
  isComplete: (value: T) => boolean = () => true
): Promise<T | undefined> {
  const hit = cache.get(key)
  if (hit && isComplete(hit)) return hit
  try {
    const value = await fetch()
    cache.set(key, value)
    return value
  } catch (err) {
    if (err instanceof TmdbAbortError) throw err
    console.error(`    [TMDB] ${label} failed: ${(err as Error).message}`)
    return hit
  }
}

/** A details entry has its credits — cached before they were requested if not. */
export const hasCredits = <T extends { credits?: unknown }>(details: T): boolean =>
  details.credits !== undefined

// ─────────────────────────────────────────────
// Title normalization
// ─────────────────────────────────────────────

/**
 * Normalize a title for matching against TMDB. Strict by design — only strips
 * characters the user couldn't have used in a filename anyway, so we never
 * silently bridge legitimate library/TMDB differences.
 *
 *   1. Strip Windows-illegal filename characters (no replacement).
 *   2. Lowercase.
 *   3. Collapse internal whitespace runs to single spaces.
 *   4. Trim.
 *
 * Diacritics are NOT stripped. "Amélie" ≠ "Amelie" because `é` is legal in
 * filenames — if the user typed it without the accent, that's a real (small)
 * divergence from TMDB's canonical title, and we surface it as no_match so
 * the user can decide whether to add the accent.
 *
 * Apostrophes, hyphens, periods, etc. are preserved since those are legal
 * in filenames.
 */
export function normalizeTitle(s: string): string {
  return stripFilenameIllegalChars(s).toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Looser normalization used as a SECOND comparison tier, never on its own.
 * Where `normalizeTitle` deletes filename-illegal characters, this one turns
 * them into a separator — because users don't only delete those characters,
 * they substitute for them. `Ghostbusters: Afterlife` can't exist on disk, so
 * the folder becomes `Ghostbusters - Afterlife`, and the strict tier never
 * sees those as equal.
 *
 *   1. Lowercase.
 *   2. Filename-illegal characters → a space (NOT deleted).
 *   3. `&` → `and` ("Pain & Gain" vs a folder named "Pain And Gain").
 *   4. " - " → a space — the standard stand-in for a subtitle colon.
 *   5. Drop incidental punctuation ("Good Morning, Vietnam").
 *   6. Collapse whitespace, trim.
 *
 * Step 4 requires whitespace on both sides, so hyphenated words survive:
 * `Spider-Man` stays `spider-man`, only ` - ` between words collapses. And it
 * must run before the whitespace collapse in step 6 or it won't see its own
 * separators.
 *
 * Both tiers are needed — neither subsumes the other:
 *   - `Face/Off` vs a folder named `FaceOff` — the STRICT tier matches these
 *     (both become `faceoff`); loose does not (`face off` vs `faceoff`).
 *   - `Ghostbusters: Afterlife` vs `Ghostbusters - Afterlife` — LOOSE matches;
 *     strict does not.
 *
 * This deliberately does NOT fold diacritics or apostrophes. Those are legal
 * in filenames, so a difference there is a real divergence worth surfacing —
 * same reasoning as the strict tier's docstring above.
 */
export function normalizeTitleLoose(s: string): string {
  return s
    .toLowerCase()
    .replace(/[<>:"|?*\\/]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s-\s/g, ' ')
    .replace(/[,.!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─────────────────────────────────────────────
// Date parsing
// ─────────────────────────────────────────────

/**
 * Parse the leading 4 digits of a TMDB date string ("YYYY-MM-DD") into an
 * integer year. Returns null when the string is missing, too short, or
 * doesn't parse as a finite number.
 *
 * TMDB returns dates as ISO strings, but with occasional empty/null values
 * for unreleased films or scheduling placeholders.
 */
export function parseYear(date: string | undefined): number | null {
  if (!date || date.length < 4) return null
  const n = parseInt(date.slice(0, 4), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Every real category a versions list touches, for the `categories` half of a
 * `WarningScope`.
 *
 * The validate warnings display only the FIRST category (the path has to be
 * one clickable string), but an item can legitimately span several. Handing
 * the ignore matcher all of them keeps a `folders:` entry from depending on
 * which category happened to sort first.
 *
 * The label of a library with no category subfolders names no real folder,
 * so it's dropped.
 */
export function categoriesOf(versions: { category: string }[]): string[] {
  return [...new Set(versions.map(v => v.category))].filter(isRealCategory)
}

// ─────────────────────────────────────────────
// Match scoring
// ─────────────────────────────────────────────

/**
 * How a TMDB search result is matched to a local movie or show: score each
 * candidate against the local title + year and assign a confidence bucket.
 *
 * ── Scoring components ─────────────────────────
 * Title match (one of, in priority order):
 *   100  exact match on either `title` or `original_title` after strict
 *        normalization (see `normalizeTitle`)
 *    90  exact match under the LOOSE normalization (see `normalizeTitleLoose`) —
 *        bridges the ways a filename-illegal character gets rendered in a folder
 *        name: "Ghostbusters - Afterlife" vs TMDB's "Ghostbusters: Afterlife",
 *        "Pain And Gain" vs "Pain & Gain", "Good Morning Vietnam" vs
 *        "Good Morning, Vietnam". Weighted so a loose hit always outranks a
 *        prefix hit (60 + 50 = 110) but never beats a strict one.
 *    60  one side is a prefix of the other followed by a space (handles missing
 *        subtitles like "Star Wars" vs "Star Wars: A New Hope")
 *    30  substring containment in either direction (last-resort fuzzy)
 *
 * Year match:
 *    50  exact
 *    30  off by 1 (US vs international release dates often differ by a year)
 *    15  off by 2
 *   -20  off by more (strong penalty — wrong year usually means wrong film)
 *
 * ── Confidence thresholds ──────────────────────
 *   high   ≥ 150  → only achievable as 100 (title exact) + 50 (year exact).
 *                   Locks in cases where both fields agree.
 *   medium ≥ 110  → 100 + 30 (title exact, year off by 1),
 *                   90 + 50 (loose title match, year exact — matched, but not
 *                   byte-identical) or 60 + 50 (prefix match, year exact).
 *   low    ≥ 60   → anything else with at least a partial title match.
 *   none   < 60   → no plausible candidate; we drop the ID entirely so the
 *                   warning isn't misleading.
 *
 * The popularity sort below means: when two candidates tie on score (very
 * common with generic titles like "Heat" or "It"), we pick the more famous
 * one — which is almost always what the user has. For shows, year off-by-one
 * is even more common: UK shows often carry UK air dates while copies are
 * tagged with the US-broadcast year.
 *
 * One override: an exact-year winner loses to a same-title candidate one year
 * off that has at least FAMOUS_MIN_VOTES votes and FAMOUS_VOTE_RATIO times the
 * winner's. That candidate keeps its own (medium) score.
 */
const FAMOUS_MIN_VOTES = 1000
const FAMOUS_VOTE_RATIO = 100

/** A search result in the shape both TMDB endpoints share once their field names are mapped. */
export interface MatchCandidate {
  id: number
  title: string
  original_title: string
  /** `release_date` for a movie, `first_air_date` for a show. */
  date?: string
  popularity?: number
  vote_count?: number
}

/**
 * Score search results against a local title + year and pick the best.
 * `preferFamous` enables the famous-film override below (movies only — a
 * remake or a namesake is the movie problem; shows haven't needed it).
 */
export function pickBestMatch(
  localTitle: string,
  localYear: number,
  candidates: MatchCandidate[],
  { preferFamous = false }: { preferFamous?: boolean } = {}
): ResolvedSearch {
  if (candidates.length === 0) {
    return { best_id: null, confidence: 'none', candidates: [] }
  }

  const ourTitle = normalizeTitle(localTitle)
  const ourLooseTitle = normalizeTitleLoose(localTitle)
  let bestScore = 0
  let bestId: number | null = null

  // Sort by popularity descending so that score ties resolve to the better-
  // known film. TMDB's `popularity` is updated nightly from view counts +
  // search frequency, so it's a decent proxy for "the one most users mean".
  const sorted = [...candidates].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))

  // Keep the top 5 for the output's `alternatives` list — anything beyond is
  // rarely worth showing. Their titles come with the search, so naming them
  // later needs no extra request.
  const kept: SearchCandidate[] = sorted
    .slice(0, 5)
    .map(c => ({ id: c.id, title: c.title, year: parseYear(c.date) }))

  const scored: { c: MatchCandidate; titleScore: number; yearDelta: number }[] = []
  let best: (typeof scored)[number] | null = null

  for (const c of sorted) {
    const theirTitle = normalizeTitle(c.title)
    const theirOrigTitle = normalizeTitle(c.original_title)
    const theirYear = parseYear(c.date)
    const yearDelta = theirYear === null ? 99 : Math.abs(theirYear - localYear)

    let score = 0

    // Title match — try both `title` (localized) and `original_title` (native).
    // Foreign films often hit on `original_title` when the user kept the
    // native name (e.g. "Amélie" vs the English-localized version).
    if (theirTitle === ourTitle || theirOrigTitle === ourTitle) {
      score += 100
    } else if (
      normalizeTitleLoose(c.title) === ourLooseTitle ||
      normalizeTitleLoose(c.original_title) === ourLooseTitle
    ) {
      score += 90
    } else if (theirTitle.startsWith(ourTitle + ' ') || ourTitle.startsWith(theirTitle + ' ')) {
      score += 60
    } else if (theirTitle.includes(ourTitle) || ourTitle.includes(theirTitle)) {
      score += 30
    }
    const titleScore = score

    // Year match. The off-by-1 case is by far the most common after exact —
    // TMDB uses the original-release year, which often differs from the wide-
    // release year a user gets their copy from. Casablanca (1942 premiere /
    // 1943 wide), 300 (2006 premiere / 2007 wide), etc.
    if (yearDelta === 0) score += 50
    else if (yearDelta === 1) score += 30
    else if (yearDelta === 2) score += 15
    else score -= 20

    const entry = { c, titleScore, yearDelta }
    scored.push(entry)
    if (score > bestScore) {
      bestScore = score
      bestId = c.id
      best = entry
    }
  }

  // A famous film one year off beats an obscure namesake on the exact year.
  // "Enemy (2013)" is Villeneuve's (TMDB dates it 2014, ~6,600 votes), not the
  // Tamil "Enemy" (2013, 8 votes) the exact year would pick. Only an
  // overwhelming vote gap overrides the year, and the result drops to the
  // score it earned on its own (medium), so it's never reported as certain.
  if (preferFamous && best && best.yearDelta === 0) {
    const bestVotes = best.c.vote_count ?? 0
    const famous = scored.find(
      s =>
        s.yearDelta === 1 &&
        s.titleScore === best.titleScore &&
        (s.c.vote_count ?? 0) >= FAMOUS_MIN_VOTES &&
        (s.c.vote_count ?? 0) >= bestVotes * FAMOUS_VOTE_RATIO
    )
    if (famous) {
      bestId = famous.c.id
      bestScore = famous.titleScore + 30
    }
  }

  let confidence: ResolvedSearch['confidence']
  if (bestScore >= 150) confidence = 'high'
  else if (bestScore >= 110) confidence = 'medium'
  else if (bestScore >= 60) confidence = 'low'
  else confidence = 'none'

  // Drop the ID for `none` so consumers don't accidentally treat a low-score
  // best guess as a real match. The candidate list is still preserved for
  // the alternatives section of the warning.
  if (confidence === 'none') bestId = null
  return { best_id: bestId, confidence, candidates: kept }
}
