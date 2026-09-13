/**
 * validate/shows.ts
 * -----------------
 * Per-show TMDB validation. Mirrors validate/movies.ts but adds the big
 * additional check: comparing each scanned season's episode count against
 * what TMDB lists as the canonical episode count. Plain gap detection
 * (from the scan pass) catches missing-in-the-middle; this catches
 * "season has 13 episodes but you only have 10".
 *
 * Specials (season 0) is intentionally skipped from the episode-count
 * comparison — TMDB's `Specials` season often includes content that doesn't
 * map cleanly to anyone's local library (early extras, web shorts, etc).
 */

import { EpisodeOutput, ShowOutput, WarningCollector } from '../core/types'
import { ShowsRules } from '../core/rules/shows'

import { JsonCache, searchKey } from './cache'
import {
  categoriesOf,
  normalizeTitle,
  normalizeTitleLoose,
  parseYear,
  stripFilenameIllegalChars,
} from './helpers'
import { TmdbClient } from './tmdb'
import {
  ShowValidation,
  ResolvedSearch,
  TmdbShowDetails,
  TmdbShowSearchResult,
  TmdbSeasonDetails,
  SeasonValidation,
} from './types'

// ─────────────────────────────────────────────
// Match scoring (shows-specific)
// ─────────────────────────────────────────────

/**
 * Same scoring shape as movies — see `pickBestMovieMatch` in
 * `validate/movies.ts` for the full rationale on weights and thresholds.
 *
 * The only TV-specific concern: matched against `name` / `original_name` /
 * `first_air_date` instead of `title` / `original_title` / `release_date`.
 * Year off-by-one is even more common for shows because UK shows often
 * use UK air dates while users tag their copies with US-broadcast year.
 */
function pickBestShowMatch(
  localTitle: string,
  localYear: number,
  candidates: TmdbShowSearchResult[]
): ResolvedSearch {
  if (candidates.length === 0) {
    return { best_id: null, confidence: 'none', candidates: [] }
  }

  const ourTitle = normalizeTitle(localTitle)
  const ourLooseTitle = normalizeTitleLoose(localTitle)
  let bestScore = 0
  let bestId: number | null = null
  const candidateIds: number[] = []

  const sorted = [...candidates].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
  for (const c of sorted.slice(0, 5)) candidateIds.push(c.id)

  for (const c of sorted) {
    const theirTitle = normalizeTitle(c.name)
    const theirOrigTitle = normalizeTitle(c.original_name)
    const theirYear = parseYear(c.first_air_date)
    const yearDelta = theirYear === null ? 99 : Math.abs(theirYear - localYear)

    let score = 0
    if (theirTitle === ourTitle || theirOrigTitle === ourTitle) {
      score += 100
    } else if (
      normalizeTitleLoose(c.name) === ourLooseTitle ||
      normalizeTitleLoose(c.original_name) === ourLooseTitle
    ) {
      score += 90
    } else if (theirTitle.startsWith(ourTitle + ' ') || ourTitle.startsWith(theirTitle + ' ')) {
      score += 60
    } else if (theirTitle.includes(ourTitle) || ourTitle.includes(theirTitle)) {
      score += 30
    }

    if (yearDelta === 0) score += 50
    else if (yearDelta === 1) score += 30
    else if (yearDelta === 2) score += 15
    else score -= 20

    if (score > bestScore) {
      bestScore = score
      bestId = c.id
    }
  }

  let confidence: ResolvedSearch['confidence']
  if (bestScore >= 150) confidence = 'high'
  else if (bestScore >= 110) confidence = 'medium'
  else if (bestScore >= 60) confidence = 'low'
  else confidence = 'none'

  if (confidence === 'none') bestId = null
  return { best_id: bestId, confidence, candidates: candidateIds }
}

// ─────────────────────────────────────────────
// Season comparison
// ─────────────────────────────────────────────

/**
 * Build per-season validation comparing local episode counts to TMDB.
 *
 * Season label handling:
 *   - Numeric labels ("1", "2", "10") → match against TMDB's season_number
 *   - "Specials" → maps to TMDB season 0 in principle, but we don't compare
 *     counts (see file docstring)
 *   - Any other named season (e.g. "Champion of Champions") is recorded but
 *     not compared
 */
function compareSeasons(
  scanned: ShowOutput['seasons'],
  tmdbDetails: TmdbShowDetails
): SeasonValidation[] {
  const tmdbByNumber = new Map<number, number>()
  for (const s of tmdbDetails.seasons) {
    tmdbByNumber.set(s.season_number, s.episode_count)
  }

  return scanned.map(s => {
    const numeric = parseInt(s.season, 10)
    let tmdbCount: number | null = null
    if (!isNaN(numeric)) {
      tmdbCount = tmdbByNumber.get(numeric) ?? null
    }
    return {
      season: s.season,
      local_episode_count: s.episode_count,
      tmdb_episode_count: tmdbCount,
      missing: tmdbCount !== null ? tmdbCount - s.episode_count : null,
    }
  })
}

// ─────────────────────────────────────────────
// Validation entry point
// ─────────────────────────────────────────────

/**
 * Compare local episode titles to TMDB's titles for the matched show.
 *
 * For each EpisodeOutput in the season:
 *   - Skip if local title is null (handled separately by warn_missing_episode_title).
 *   - Single-episode files: compare local vs TMDB[episode_start] with strict
 *     filename-safe normalization, then with `normalizeTitleLoose` as a
 *     fallback tier. The second tier exists because the strict form of a TMDB
 *     title is sometimes unstorable: Windows drops trailing periods, so
 *     `All Good Things...` can only ever land on disk as `All Good Things`.
 *     Flagging that as a mismatch reports the filesystem, not the user.
 *   - Multi-episode files (S01E01-E02): only checked when the
 *     `warn_tmdb_episode_name_multi_episode` toggle is true. Accepted if the
 *     local title equals ANY single constituent TMDB title (filename names
 *     just the primary episode) OR if every constituent title appears as a
 *     substring of the local title in episode order (filename joins all
 *     parts — joiner doesn't matter, since the filesystem-safe `/` is illegal
 *     and users substitute spaces / `&` / `,` / etc.).
 *
 * Returns a list of mismatched episodes for the caller to emit warnings on.
 */
function findEpisodeTitleMismatches(
  localEpisodes: EpisodeOutput[],
  tmdbSeason: TmdbSeasonDetails,
  checkMultiEpisode: boolean
): Array<{ episode_start: number; episode_end: number; local: string; tmdb: string[] }> {
  const tmdbByNumber = new Map<number, string>()
  for (const ep of tmdbSeason.episodes) {
    tmdbByNumber.set(ep.episode_number, ep.name)
  }

  const mismatches: Array<{
    episode_start: number
    episode_end: number
    local: string
    tmdb: string[]
  }> = []

  for (const ep of localEpisodes) {
    if (ep.title === null) continue // no filename title to compare

    const isMultiEpisode = ep.episode_start !== ep.episode_end
    if (isMultiEpisode && !checkMultiEpisode) continue

    const tmdbTitles: string[] = []
    for (let n = ep.episode_start; n <= ep.episode_end; n++) {
      const name = tmdbByNumber.get(n)
      if (name !== undefined) tmdbTitles.push(name)
    }
    // No TMDB titles → can't compare. Probably out-of-range episode numbers
    // (web extras, mislabelled files). Stay silent; warn_tmdb_episode_count
    // already surfaces structural issues.
    if (tmdbTitles.length === 0) continue

    const normalize = (s: string) => stripFilenameIllegalChars(s).trim().toLowerCase()
    const localSafe = normalize(ep.title)
    const tmdbSafe = tmdbTitles.map(normalize)

    const matchesSingle = tmdbSafe.some(t => t === localSafe)
    const matchesCombined =
      isMultiEpisode && tmdbSafe.length > 1 && containsAllInOrder(localSafe, tmdbSafe)

    // Second tier, mirroring how pickBestShowMatch and pickBestMovieMatch
    // already pair strict and loose normalization. Needed because the strict
    // tier compares against a title the filesystem may not be able to store:
    // Windows silently drops trailing periods, so `All Good Things...` and
    // `T.R.A.C.K.S.` CANNOT exist on disk in canonical form. Reporting a name
    // the OS refuses to create as a user error is just noise.
    const localLoose = normalizeTitleLoose(ep.title)
    const matchesLoose = tmdbTitles.some(t => normalizeTitleLoose(t) === localLoose)
    const matchesLooseCombined =
      isMultiEpisode &&
      tmdbTitles.length > 1 &&
      containsAllInOrder(
        localLoose,
        tmdbTitles.map(t => normalizeTitleLoose(t))
      )

    if (!matchesSingle && !matchesCombined && !matchesLoose && !matchesLooseCombined) {
      mismatches.push({
        episode_start: ep.episode_start,
        episode_end: ep.episode_end,
        local: ep.title,
        tmdb: tmdbTitles,
      })
    }
  }

  return mismatches
}

/**
 * True if every part appears as a substring of `haystack`, in order, with no
 * overlap. Used to accept multi-episode filenames that concatenate every
 * constituent TMDB title with an arbitrary joiner (Windows forbids `/` so
 * users substitute spaces, `&`, `,`, etc.).
 */
function containsAllInOrder(haystack: string, parts: string[]): boolean {
  let pos = 0
  for (const p of parts) {
    if (p.length === 0) return false
    const idx = haystack.indexOf(p, pos)
    if (idx === -1) return false
    pos = idx + p.length
  }
  return true
}

export async function validateShows(
  shows: ShowOutput[],
  rules: ShowsRules,
  client: TmdbClient,
  searchCache: JsonCache<ResolvedSearch>,
  detailsCache: JsonCache<TmdbShowDetails>,
  seasonsCache: JsonCache<TmdbSeasonDetails>,
  warnings: WarningCollector,
  onProgress?: (done: number, total: number, cached: number) => void
): Promise<ShowValidation[]> {
  const out: ShowValidation[] = []
  let cachedCount = 0

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i]!
    const sKey = searchKey('show', show.title, show.year)

    // Cached no-match / low-confidence verdicts are always re-queried — see
    // the matching comment in validate/movies.ts for the rationale.
    const cached = searchCache.get(sKey)
    let resolved: ResolvedSearch | undefined =
      cached && cached.confidence !== 'none' && cached.confidence !== 'low' ? cached : undefined
    if (resolved) {
      cachedCount++
    } else {
      try {
        const candidates = await client.searchShow(show.title, show.year)
        resolved = pickBestShowMatch(show.title, show.year, candidates)
        searchCache.set(sKey, resolved)
      } catch (err) {
        console.error(
          `    [TMDB] Search failed for ${show.title} (${show.year}): ${(err as Error).message}`
        )
        resolved = { best_id: null, confidence: 'none', candidates: [] }
      }
    }

    const entry: ShowValidation = {
      title: show.title,
      year: show.year,
      confidence: resolved.confidence,
      tmdb_id: resolved.best_id,
      tmdb_title: null,
      tmdb_title_filename_safe: null,
      tmdb_first_air_year: null,
      alternatives: [],
      seasons: show.seasons.map(s => ({
        season: s.season,
        local_episode_count: s.episode_count,
        tmdb_episode_count: null,
        missing: null,
      })),
    }

    let details: TmdbShowDetails | undefined
    if (resolved.best_id !== null) {
      details = detailsCache.get(String(resolved.best_id))
      if (!details) {
        try {
          details = await client.getShow(resolved.best_id)
          detailsCache.set(String(resolved.best_id), details)
        } catch (err) {
          console.error(
            `    [TMDB] Details failed for show id=${resolved.best_id}: ${(err as Error).message}`
          )
        }
      }
      if (details) {
        entry.tmdb_title = details.name
        entry.tmdb_title_filename_safe = stripFilenameIllegalChars(details.name)
        entry.tmdb_first_air_year = parseYear(details.first_air_date)
        entry.seasons = compareSeasons(show.seasons, details)
      }
    }

    // Collect alternates from cache for review
    for (const altId of resolved.candidates) {
      if (altId === resolved.best_id) continue
      const altDetails = detailsCache.get(String(altId))
      if (altDetails) {
        entry.alternatives.push({
          id: altId,
          title: altDetails.name,
          year: parseYear(altDetails.first_air_date),
        })
      }
    }

    // Warnings. Path is prefixed with the show's first category (taken from
    // the first season's first version) so flat-library and quality-organized
    // users both get a clickable, copy-pasteable folder path. "default" is
    // the sentinel for an empty `categories` config — skip the prefix there.
    const label = `${show.title} (${show.year})`
    const firstCategory = show.seasons[0]?.versions[0]?.category
    const showPath =
      firstCategory && firstCategory !== 'default' ? `${firstCategory}/${label}` : label

    // The displayed path names only the first category, but a show can span
    // several. Give the ignore matcher every one of them so a `folders:` entry
    // isn't at the mercy of which category happened to sort first.
    const showScope = {
      categories: categoriesOf(show.seasons.flatMap(s => s.versions)),
      levels: [label],
    }

    if (resolved.confidence === 'none' && rules.checks.warn_tmdb_no_match) {
      warnings.add(
        'warn_tmdb_no_match',
        showPath,
        `TMDB found no match for '${show.title}' (${show.year}). Possible typo or this show isn't in TMDB.`,
        { scope: showScope }
      )
    } else if (resolved.confidence === 'low' && rules.checks.warn_tmdb_low_confidence) {
      const altText =
        entry.alternatives.length > 0
          ? ` Alternatives: ${entry.alternatives.map(a => `'${a.title}' (${a.year})`).join(', ')}.`
          : ''
      warnings.add(
        'warn_tmdb_low_confidence',
        showPath,
        `TMDB low-confidence match: best guess is '${entry.tmdb_title}' (${entry.tmdb_first_air_year}).${altText} Review and confirm.`,
        { scope: showScope }
      )
    }

    // Canonical title check — fires when a match was made and folder title
    // differs (byte-for-byte) from TMDB's filename-safe form.
    if (
      rules.checks.warn_tmdb_title_canonical &&
      entry.tmdb_title_filename_safe !== null &&
      entry.tmdb_title_filename_safe !== show.title
    ) {
      warnings.add(
        'warn_tmdb_title_canonical',
        showPath,
        `TMDB canonical title differs: folder is '${show.title}', TMDB filename-safe form is '${entry.tmdb_title_filename_safe}'. Consider renaming the folder to match.`,
        { scope: showScope }
      )
    }

    // Per-season episode count check (skip season 0 / "Specials" — see header).
    // Per-season warnings use that season's own first category, because a
    // show can legitimately span categories per season (S1 in HD, S2 in UHD).
    if (rules.checks.warn_tmdb_episode_count && details !== undefined) {
      for (let s = 0; s < entry.seasons.length; s++) {
        const season = entry.seasons[s]!
        if (season.tmdb_episode_count === null) continue
        if (season.season === '0' || season.season.toLowerCase() === 'specials') continue
        if (season.missing !== null && season.missing > 0) {
          const seasonCategory = show.seasons[s]?.versions[0]?.category
          const seasonShowPath =
            seasonCategory && seasonCategory !== 'default' ? `${seasonCategory}/${label}` : label
          warnings.add(
            'warn_tmdb_episode_count',
            `${seasonShowPath}/Season ${season.season}`,
            `Season ${season.season} has ${season.local_episode_count} of ${season.tmdb_episode_count} episodes per TMDB (${season.missing} missing). Identify gaps via shows.json or the scan's potential-missing-episodes warning.`,
            // `Season 3` here is the parsed TMDB number, not the on-disk
            // `Season 03` folder; core/ignored.ts folds the two onto one key
            // so a single `seasons:` entry covers this and the scan pass.
            {
              scope: {
                categories: categoriesOf(show.seasons[s]?.versions ?? []),
                levels: [label, `Season ${season.season}`],
              },
            }
          )
        }
      }
    }

    // Per-episode title check. Only runs when we have a confident TMDB match
    // (details fetched) and the toggle is on. One TMDB API call per season
    // that has episodes to check — cached by (show_id, season_number).
    if (
      rules.checks.warn_tmdb_episode_name_mismatch &&
      resolved.best_id !== null &&
      details !== undefined
    ) {
      for (let s = 0; s < entry.seasons.length; s++) {
        const season = entry.seasons[s]!
        const localSeason = show.seasons[s]
        if (!localSeason || localSeason.episodes.length === 0) continue

        const seasonNumber = parseInt(season.season, 10)
        if (isNaN(seasonNumber)) continue // named seasons like "Specials"

        // Skip if TMDB doesn't claim a season at this number — keeps us from
        // wasting a call on a numbering mismatch already reported elsewhere.
        const tmdbHasSeason = details.seasons.some(s2 => s2.season_number === seasonNumber)
        if (!tmdbHasSeason) continue

        const seasonCacheKey = `${resolved.best_id}:${seasonNumber}`
        let tmdbSeason = seasonsCache.get(seasonCacheKey)
        if (!tmdbSeason) {
          try {
            tmdbSeason = await client.getShowSeason(resolved.best_id, seasonNumber)
            seasonsCache.set(seasonCacheKey, tmdbSeason)
          } catch (err) {
            console.error(
              `    [TMDB] Season details failed for show ${resolved.best_id} S${seasonNumber}: ${(err as Error).message}`
            )
            continue
          }
        }

        const mismatches = findEpisodeTitleMismatches(
          localSeason.episodes,
          tmdbSeason,
          rules.checks.warn_tmdb_episode_name_multi_episode
        )
        if (mismatches.length === 0) continue

        const seasonCategory = localSeason.versions[0]?.category
        const seasonShowPath =
          seasonCategory && seasonCategory !== 'default' ? `${seasonCategory}/${label}` : label

        for (const m of mismatches) {
          const epLabel =
            m.episode_start === m.episode_end
              ? `S${String(seasonNumber).padStart(2, '0')}E${String(m.episode_start).padStart(2, '0')}`
              : `S${String(seasonNumber).padStart(2, '0')}E${String(m.episode_start).padStart(2, '0')}-E${String(m.episode_end).padStart(2, '0')}`
          const tmdbExpected =
            m.tmdb.length === 1 ? `'${m.tmdb[0]}'` : m.tmdb.map(t => `'${t}'`).join(' / ')
          warnings.add(
            'warn_tmdb_episode_name_mismatch',
            `${seasonShowPath}/${epLabel}`,
            `Episode title '${m.local}' differs from TMDB's ${tmdbExpected}. Verify which is correct.`,
            // The path's last segment is an episode CODE, not a filename, so
            // derivation would read it as a season. Naming the season
            // explicitly puts the code at the episode level, where an
            // `episodes:` entry — written as the code OR as the episode's
            // filename — can reach it.
            {
              scope: {
                categories: categoriesOf(localSeason.versions),
                levels: [label, `Season ${seasonNumber}`, epLabel],
              },
            }
          )
        }
      }
    }

    out.push(entry)
    onProgress?.(i + 1, shows.length, cachedCount)
  }

  return out
}
