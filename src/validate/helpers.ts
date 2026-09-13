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

export { stripFilenameIllegalChars }

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
 * 'default' is the sentinel `resolveCategories` uses for a library with no
 * category subfolders; it names no real folder, so it's dropped.
 */
export function categoriesOf(versions: { category: string }[]): string[] {
  return [...new Set(versions.map(v => v.category))].filter(c => c !== 'default')
}
