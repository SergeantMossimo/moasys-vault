/**
 * plex/checks.ts
 * --------------
 * Compare a Plex pull with the scanner's view of one media type on one drive
 * and emit warnings. Pure apart from the injected `exists` probe, so every
 * check is testable against fixture catalogs.
 *
 * All paths in warnings are library-relative (the same shape as warnings.json
 * from the scan), so the per-drive ignore lists apply unchanged.
 *
 * Recommended fixes are always actions to take in Plex or on disk yourself —
 * nothing here, or in the Plex client, changes the server.
 */

import { WarningCollector } from '../core/types'
import { PlexRules } from '../core/rules/plex'
import { comparableTitle } from '../probe/audiobook-tags'
import { normalizeTitleLoose } from '../validate/helpers'

import { agentMatches, isUnmatched } from './catalog'
import { MediaType, PlexCatalogItem, PlexCatalogOutput, PlexFileRef } from './types'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface PlexCheckInput {
  mediaType: MediaType
  /** Root name from config.json. */
  drive: string
  /** Pulled catalogs of every Plex library that maps to this media type. */
  catalogs: PlexCatalogOutput[]
  /** Library-relative paths of every file the probe pass found on this drive. */
  diskFiles: string[]
  /** Does a library-relative path exist on disk? Consulted only for files Plex has and the scan didn't list. */
  exists: (relative: string) => boolean
  /**
   * The folder-naming pattern with `title` and `year` groups — movies'
   * `patterns.folder` or shows' `patterns.show_folder`. Null for music and
   * audiobooks, whose Plex titles come from tags already checked by the scan.
   */
  folderPattern: RegExp | null
  /**
   * Confident TMDB matches from the validate pass (validation.json), keyed by
   * `tmdbMatchKey(folder title, folder year)`. When both this and Plex have a
   * TMDB id for a folder, the ids decide the title check outright. Omitted
   * when validation hasn't been run.
   */
  tmdbMatches?: Map<string, { id: number; title: string | null }>
  rules: PlexRules
  warnings: WarningCollector
}

export interface PlexCheckStats {
  plexFiles: number
  diskFiles: number
}

// ─────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

const key = (p: string) => p.toLowerCase()

/**
 * `warn_plex_title_mismatch` fires from two branches — comparing TMDB ids when
 * the validate pass has run, comparing titles when it hasn't — but both land in
 * one bucket, so they have to share one `fix`. See `WarningOptions.fix`.
 */
const FIX_TITLE_MISMATCH =
  `Usually Plex matched the wrong title — use "Fix Match…" in Plex. If Plex is right, rename ` +
  `the folder instead. Where two TMDB ids are shown, one is wrong (often a remake or a ` +
  `same-title film): look both up on themoviedb.org, and if validation is the wrong one, the ` +
  `folder's year likely points at the other title.`

/**
 * `warn_plex_edition_mismatch` fires from three branches — Plex has an edition
 * the folder doesn't, the folder has one Plex doesn't, and the two disagree —
 * so all three share one `fix`. See `WarningOptions.fix`.
 */
const FIX_EDITION_MISMATCH =
  `Plex reads the edition off the show folder's {edition-…} tag, so this usually means it ` +
  `hasn't re-scanned since the folder was renamed: run "Scan Library Files". Editing the ` +
  `edition in Plex Web also overrides the folder until you clear it.`

/** `a.mkv`, `b.mkv`, `c.mkv` +2 more */
function listNames(paths: string[], max = 5): string {
  const names = paths.slice(0, max).map(p => `'${basename(p)}'`)
  return names.join(', ') + (paths.length > max ? `, +${paths.length - max} more` : '')
}

function groupByFolder<T>(entries: T[], pathOf: (e: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const e of entries) {
    const folder = dirname(pathOf(e))
    const list = groups.get(folder) ?? []
    list.push(e)
    groups.set(folder, list)
  }
  return groups
}

// ─────────────────────────────────────────────
// Title comparison
// ─────────────────────────────────────────────

export type TitleComparison = 'match' | 'case' | 'mismatch'

/**
 * Compare Plex's title (or its original title, for foreign films Plex shows
 * localized) with a folder title. Characters a folder can't hold, `: ` vs
 * ` - `, and punctuation-only differences all match.
 */
export function compareTitles(
  plexTitle: string,
  originalTitle: string | null,
  folderTitle: string,
  years: Array<number | null> = []
): TitleComparison {
  const folder = comparableTitle(folderTitle)
  let best: TitleComparison = 'mismatch'
  for (const candidate of [plexTitle, originalTitle]) {
    if (!candidate) continue
    const plex = comparableTitle(stripDisambiguator(candidate, years))
    if (plex === folder) return 'match'
    if (plex.toLowerCase() === folder.toLowerCase()) {
      best = 'case'
      continue
    }
    if (withoutArticle(normalizeTitleLoose(plex)) === withoutArticle(normalizeTitleLoose(folder))) {
      return 'match'
    }
  }
  return best
}

/** Drop a leading English article: Plex has `Upside` where the folder has `The Upside`. */
function withoutArticle(s: string): string {
  return s.replace(/^(?:the|a|an)\s+/i, '')
}

/**
 * Plex appends a year or country to tell same-named shows apart —
 * `Cosmos (2014)`, `The Office (US)`. Folder names carry the year separately
 * and never the country, so neither is a real difference.
 *
 * For thinly matched items Plex sometimes appends the year bare:
 * `Space King 2024`. That form is only stripped when the number is within a
 * year of the folder's or Plex's own year, so titles that really end in a
 * year — `Blade Runner 2049` (2017) — are left alone.
 */
export function stripDisambiguator(title: string, years: Array<number | null> = []): string {
  const stripped = title.replace(/\s+\((?:\d{4}|[A-Z]{2})\)$/, '')
  if (stripped !== title) return stripped
  const bare = /^(.+?)\s+(\d{4})$/.exec(title)
  if (!bare) return title
  const suffix = Number(bare[2])
  return years.some(y => y !== null && Math.abs(y - suffix) <= 1) ? bare[1]! : title
}

/**
 * Does one title's word set contain the other's? Canonical titles often
 * wrap the name a folder uses — `Star Wars: Episode VI - Return of the Jedi`,
 * `Dune: Part One`, `Deon Cole: Cole Blooded Seminar` — without being a
 * different film. Only trusted alongside a matching year: `Mud` and
 * `Mud Lotus` overlap too.
 */
export function titlesOverlap(
  plexTitle: string,
  folderTitle: string,
  years: Array<number | null> = []
): boolean {
  const words = (s: string) =>
    new Set(
      normalizeTitleLoose(comparableTitle(stripDisambiguator(s, years)))
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length > 0)
    )
  const a = words(plexTitle)
  const b = words(folderTitle)
  if (a.size === 0 || b.size === 0) return false
  const within = (x: Set<string>, y: Set<string>) => [...x].every(w => y.has(w))
  return within(a, b) || within(b, a)
}

/** Key for joining a folder's parsed title and year to the TMDB validation output. */
export function tmdbMatchKey(title: string, year: number | null): string {
  return `${title.toLowerCase()}|${year ?? ''}`
}

/** The TMDB id from an item's external ids, e.g. `tmdb://1892` → 1892. */
function plexTmdbId(item: PlexCatalogItem): number | null {
  const ref = item.external_ids.find(id => id.startsWith('tmdb://'))
  const n = ref ? Number(ref.slice('tmdb://'.length)) : NaN
  return Number.isFinite(n) ? n : null
}

// ─────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────

interface PlexFileEntry {
  item: PlexCatalogItem
  file: PlexFileRef & { library_path: string }
  library: string
}

export function checkPlex(input: PlexCheckInput): PlexCheckStats {
  const { rules, warnings, drive } = input
  const onDrive = (f: PlexFileRef): f is PlexFileRef & { library_path: string } =>
    f.library_path !== null && f.drive !== null && f.drive.toLowerCase() === drive.toLowerCase()

  const plexFiles: PlexFileEntry[] = []
  for (const catalog of input.catalogs) {
    for (const item of catalog.items) {
      for (const file of item.files) {
        if (onDrive(file)) plexFiles.push({ item, file, library: catalog.library.title })
      }
    }
  }

  const plexPaths = new Set(plexFiles.map(e => key(e.file.library_path)))
  const diskPaths = new Set(input.diskFiles.map(key))
  const libraryNames = input.catalogs.map(c => `'${c.library.title}'`).join(', ')

  // ── On disk, outside every Plex library folder ──────────────────────
  // A file no library folder covers will never be scanned, however often you
  // rescan — that needs a different fix than a file Plex merely missed.
  // Catalogs from before `mapped_locations` existed skip this distinction.
  const covering = input.catalogs.flatMap(c =>
    (c.library.mapped_locations ?? []).filter(l => l.drive.toLowerCase() === drive.toLowerCase())
  )
  const knowsLocations = input.catalogs.some(c => c.library.mapped_locations !== undefined)
  const covered = (p: string) =>
    !knowsLocations ||
    covering.some(l => l.library_path === '' || key(p).startsWith(`${key(l.library_path)}/`))
  const uncovered = input.diskFiles.filter(p => !covered(p))

  if (rules.checks.warn_plex_folder_not_in_library && uncovered.length > 0) {
    // Report at the shallowest uncovered folder, so an unlisted category is
    // one warning rather than one per book or movie.
    const hasLibraryFolderBelow = (folder: string) =>
      covering.some(l => key(l.library_path).startsWith(`${key(folder)}/`))
    const byTop = new Map<string, string[]>()
    for (const p of uncovered) {
      const segments = p.split('/')
      let top = segments.slice(0, -1).join('/')
      for (let depth = 1; depth < segments.length; depth++) {
        const prefix = segments.slice(0, depth).join('/')
        if (!hasLibraryFolderBelow(prefix)) {
          top = prefix
          break
        }
      }
      byTop.set(top, [...(byTop.get(top) ?? []), p])
    }
    const folders = covering.map(l => `'${l.plex_path}'`).join(', ')
    for (const [top, files] of byTop) {
      warnings.add(
        'warn_plex_folder_not_in_library',
        top,
        `Outside every folder of ${libraryNames}, so its ${files.length} file(s) are never ` +
          `scanned: ${listNames(files, 3)}.`,
        {
          fix:
            `In Plex, edit the library and add this folder — or move the files into one it ` +
            `already covers (${folders}). Rescanning alone will not help.`,
        }
      )
    }
  }

  // ── On disk, not in Plex ────────────────────────────────────────────
  if (rules.checks.warn_plex_missing_item) {
    const missing = input.diskFiles.filter(p => covered(p) && !plexPaths.has(key(p)))
    const diskByFolder = groupByFolder(input.diskFiles, p => p)
    for (const [folder, files] of groupByFolder(missing, p => p)) {
      const total = diskByFolder.get(folder)?.length ?? files.length
      const which =
        files.length === total
          ? `None of the ${total} file(s) in this folder are in Plex`
          : `${files.length} of the ${total} file(s) in this folder aren't in Plex`
      warnings.add('warn_plex_missing_item', folder, `${which}: ${listNames(files)}.`, {
        fix:
          `In Plex, run "Scan Library Files" on ${libraryNames}. If they still don't appear, ` +
          `the names likely break Plex's naming convention — check this folder in warnings.json.`,
      })
    }
  }

  // ── In Plex, gone from disk ─────────────────────────────────────────
  const unavailable = plexFiles.filter(e => e.file.deleted)
  const orphans = plexFiles.filter(
    e =>
      !e.file.deleted &&
      !diskPaths.has(key(e.file.library_path)) &&
      !input.exists(e.file.library_path)
  )

  if (rules.checks.warn_plex_unavailable) {
    for (const [folder, entries] of groupByFolder(unavailable, e => e.file.library_path)) {
      const paths = entries.map(e => e.file.library_path)
      const back = paths.filter(p => diskPaths.has(key(p)) || input.exists(p))
      // Whether the files came back is a per-row fact, so it stays on the row;
      // what to do about either case is the same every time, so it's the fix.
      const note = back.length > 0 ? ` ${back.length} of them are on disk again.` : ''
      warnings.add(
        'warn_plex_unavailable',
        folder,
        `Plex marks ${entries.length} file(s) here deleted, showing as unavailable: ` +
          `${listNames(paths)}.${note}`,
        {
          fix:
            `If the files are back on disk, "Scan Library Files" on ${libraryNames} restores ` +
            `them. If they really are gone, "Empty Trash" clears the stale entries.`,
        }
      )
    }
  }

  if (rules.checks.warn_plex_orphan_item) {
    for (const [folder, entries] of groupByFolder(orphans, e => e.file.library_path)) {
      const paths = entries.map(e => e.file.library_path)
      warnings.add(
        'warn_plex_orphan_item',
        folder,
        `Plex still lists ${entries.length} file(s) here that are gone from disk: ` +
          `${listNames(paths)}.`,
        {
          fix:
            `In Plex, run "Scan Library Files" on ${libraryNames}, then "Empty Trash" — or ` +
            `restore the files if they were moved or deleted by mistake.`,
        }
      )
    }
  }

  // ── Item-level checks ───────────────────────────────────────────────
  /** The folder that represents an item on this drive, or null when it isn't on this drive. */
  const folderOf = (item: PlexCatalogItem): string | null => {
    switch (item.type) {
      case 'movie': {
        const f = item.files.find(onDrive)?.library_path
        return f === undefined ? null : dirname(f)
      }
      case 'show': {
        // A show owns no files; take the show folder from one of its episodes,
        // which sit one level down in a season folder.
        const episode = plexFiles.find(e => e.item.grandparent_rating_key === item.rating_key)
        return episode ? dirname(dirname(episode.file.library_path)) : null
      }
      case 'album': {
        const track = plexFiles.find(e => e.item.parent_rating_key === item.rating_key)
        return track ? dirname(track.file.library_path) : null
      }
      default:
        return item.files.find(onDrive)?.library_path ?? null
    }
  }

  const reportUnmatched = (item: PlexCatalogItem): void => {
    const folder = folderOf(item)
    if (folder === null) return
    warnings.add(
      'warn_plex_unmatched',
      folder,
      `Plex couldn't match this to its metadata agent — it shows as '${item.title}' with no ` +
        `poster, summary or ratings.`,
      {
        fix:
          `In Plex, use "Fix Match…" on it. If no match is offered, check the folder name ` +
          `against Plex's naming convention.`,
      }
    )
  }

  // Several Plex items can share one folder — editions (`{edition-Extended}`)
  // are separate items — so each folder's title is checked once.
  const titleChecked = new Set<string>()

  const checkTitle = (item: PlexCatalogItem, pattern: RegExp): void => {
    const folder = folderOf(item)
    if (folder === null || titleChecked.has(key(folder))) return
    const groups = pattern.exec(basename(folder))?.groups
    if (!groups?.title) return
    titleChecked.add(key(folder))

    const folderYear = groups.year ? parseInt(groups.year, 10) : null
    const plexLabel = item.year !== null ? `'${item.title}' (${item.year})` : `'${item.title}'`

    // Best evidence first: the TMDB id Plex matched vs the one the validate
    // pass matched. Agreement settles it — any title difference is then a
    // naming question, which warn_tmdb_title_canonical owns.
    const tmdb = input.tmdbMatches?.get(tmdbMatchKey(groups.title, folderYear))
    const plexId = plexTmdbId(item)
    if (tmdb && plexId !== null) {
      if (tmdb.id !== plexId && rules.checks.warn_plex_title_mismatch) {
        warnings.add(
          'warn_plex_title_mismatch',
          folder,
          `Plex says ${plexLabel} (TMDB ${plexId}), validation says ` +
            `'${tmdb.title ?? 'unknown'}' (TMDB ${tmdb.id}).`,
          { fix: FIX_TITLE_MISMATCH }
        )
      }
      return
    }

    // Fallback: compare the text. Canonical titles often wrap the folder's
    // name, so word overlap counts as a match — but only with the same year.
    // Plex's year is null when it has little metadata; then only the title can
    // decide, and word overlap isn't enough (`La luna` vs `Bajo la luna`).
    const years = [folderYear, item.year]
    const comparison = compareTitles(item.title, item.original_title, groups.title, years)
    const sameYear = folderYear !== null && item.year === folderYear
    const yearOff =
      folderYear !== null && item.year !== null && Math.abs(folderYear - item.year) > 1
    const mismatch =
      yearOff ||
      (comparison === 'mismatch' && !(sameYear && titlesOverlap(item.title, groups.title, years)))

    if (mismatch && rules.checks.warn_plex_title_mismatch) {
      warnings.add(
        'warn_plex_title_mismatch',
        folder,
        `Plex identifies this folder as ${plexLabel}, which doesn't match its name.`,
        { fix: FIX_TITLE_MISMATCH }
      )
    } else if (comparison === 'case' && rules.checks.warn_plex_title_case) {
      warnings.add(
        'warn_plex_title_case',
        folder,
        `Capitalization only: Plex titles it ${plexLabel}.`,
        { fix: `Rename the folder to match if you want the two to agree.` }
      )
    }
  }

  // Same per-folder dedupe as titles, but a separate set: checkTitle returns
  // early once the TMDB ids agree, and the edition still needs checking then.
  const editionChecked = new Set<string>()

  /**
   * Compare Plex's edition name for a show against the `{edition-…}` tag on
   * its folder. Shows only: on a movie the tag lives in the *filename*, so the
   * folder carries none and every movie would read as a mismatch.
   */
  const checkEdition = (item: PlexCatalogItem, pattern: RegExp): void => {
    // Absent (rather than null) means this catalog.json predates editions —
    // there is nothing to compare until the next plex:pull.
    if (item.edition_title === undefined) return

    const folder = folderOf(item)
    if (folder === null || editionChecked.has(key(folder))) return
    const groups = pattern.exec(basename(folder))?.groups
    if (!groups?.title) return
    editionChecked.add(key(folder))

    // `groups.edition` is undefined with no tag and '' for a bare
    // `{edition-}`; the scan pass treats both as "no edition" (warning about
    // the latter as warn_empty_edition), so fold them together here too.
    const folderEdition = groups.edition?.trim() ?? ''
    const plexEdition = item.edition_title ?? ''

    if (folderEdition === plexEdition) return

    if (folderEdition === '' || plexEdition === '') {
      if (!rules.checks.warn_plex_edition_mismatch) return
      const issue =
        plexEdition === ''
          ? `Folder is tagged '{edition-${folderEdition}}', Plex shows no edition.`
          : `Plex calls this the '${plexEdition}' edition, the folder carries no tag.`
      warnings.add('warn_plex_edition_mismatch', folder, issue, { fix: FIX_EDITION_MISMATCH })
      return
    }

    if (folderEdition.toLowerCase() !== plexEdition.toLowerCase()) {
      if (rules.checks.warn_plex_edition_mismatch) {
        warnings.add(
          'warn_plex_edition_mismatch',
          folder,
          `Plex says '${plexEdition}', the folder says '${folderEdition}'.`,
          { fix: FIX_EDITION_MISMATCH }
        )
      }
    } else if (rules.checks.warn_plex_edition_case) {
      warnings.add(
        'warn_plex_edition_case',
        folder,
        `Capitalization only: Plex says '${plexEdition}', the folder says '${folderEdition}'.`,
        { fix: `Rename the folder's tag to match if you want the two to agree.` }
      )
    }
  }

  const reportDuplicate = (item: PlexCatalogItem): void => {
    const onThisDrive = item.files.filter(onDrive)
    if (onThisDrive.length === 0) return
    const locations = item.files.map(f =>
      f.library_path !== null ? `${f.drive}:${f.library_path}` : f.plex_path
    )
    const path =
      item.type === 'movie' ? dirname(onThisDrive[0]!.library_path) : onThisDrive[0]!.library_path
    warnings.add(
      'warn_plex_duplicate',
      path,
      `Plex merges ${item.files.length} files into '${item.title}': ${locations.join('; ')}.`,
      {
        fix:
          `Fine for deliberate versions like HD plus UHD, or a director's cut. Otherwise delete ` +
          `the extra copy — or use "Split Apart" in Plex if they are actually different titles.`,
      }
    )
  }

  for (const catalog of input.catalogs) {
    // Unmatched is only meaningful where the library's agent actually matches,
    // and not for audiobooks: Plex looks them up in music databases, which
    // don't carry them, so nearly every book would be flagged.
    const matching = agentMatches(catalog.library.agent) && input.mediaType !== 'audiobooks'

    for (const item of catalog.items) {
      if (
        rules.checks.warn_plex_unmatched &&
        matching &&
        (item.type === 'movie' || item.type === 'show' || item.type === 'album') &&
        isUnmatched(item)
      ) {
        reportUnmatched(item)
      }

      const titled =
        (input.mediaType === 'movies' && item.type === 'movie') ||
        (input.mediaType === 'shows' && item.type === 'show')
      if (input.folderPattern && titled) checkTitle(item, input.folderPattern)

      // Shows only — see checkEdition.
      if (input.folderPattern && input.mediaType === 'shows' && item.type === 'show') {
        checkEdition(item, input.folderPattern)
      }

      if (rules.checks.warn_plex_duplicate && item.duplicate) reportDuplicate(item)
    }
  }

  return { plexFiles: plexFiles.length, diskFiles: input.diskFiles.length }
}
