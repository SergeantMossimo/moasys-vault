import fs from 'fs'
import path from 'path'

import { describe, it, expect, vi } from 'vitest'

import { defaultShowsRules } from '../../../src/core/rules/shows'
import { compilePattern, LENIENT_EPISODE_FILE } from '../../../src/core/rules/helpers'
import {
  joinStem,
  planEpisodeCode,
  planEpisodeTitles,
  planShowFolder,
  planShowPrefix,
  renameFile,
  sanitizeEpisodeTitle,
  splitStem,
  validatePlan,
  validateUndoManifest,
  type Plan,
  type PlanEntry,
} from '../../../src/tools/rename-shows'
import { buildLibrary, cleanupLibrary, type DirSpec } from '../../fixtures/library'

const fileRegex = compilePattern(defaultShowsRules.patterns.file)

function makePlan(entries: PlanEntry[]): Plan {
  return {
    generated: '2026-01-01T00:00:00.000Z',
    fix: 'show-prefix',
    drive: 'Test',
    root_path: 'X:\\Shows',
    entries,
    skipped: [],
    review: [],
  }
}

// ─────────────────────────────────────────────
// splitStem / joinStem
// ─────────────────────────────────────────────

describe('splitStem', () => {
  it('splits a plain episode filename', () => {
    expect(splitStem('Barry (2018) - s02e05', fileRegex)).toEqual({
      prefix: 'Barry (2018)',
      code: 's02e05',
      title: null,
      seasonNumber: 2,
      episodeStart: 5,
      episodeEnd: 5,
    })
  })

  it('captures a trailing episode title', () => {
    const parts = splitStem('Barry (2018) - s02e05 - ronny lily', fileRegex)
    expect(parts?.title).toBe('ronny lily')
  })

  it('preserves the episode code casing exactly as written', () => {
    // The whole point of capturing raw text rather than parsed integers: a
    // show-prefix fix must not silently restyle a code the user didn't ask
    // us to touch.
    expect(splitStem('Dune Prophecy (2024) - S01e02', fileRegex)?.code).toBe('S01e02')
    expect(splitStem('MASH (1972) - s04e25', fileRegex)?.code).toBe('s04e25')
  })

  it('handles both multi-episode suffix forms', () => {
    expect(splitStem('Abbott Elementary (2021) - S03e01-e02', fileRegex)).toMatchObject({
      code: 'S03e01-e02',
      episodeStart: 1,
      episodeEnd: 2,
    })
    expect(splitStem('Abbott Elementary (2021) - S03e01-02', fileRegex)).toMatchObject({
      code: 'S03e01-02',
      episodeStart: 1,
      episodeEnd: 2,
    })
  })

  it('keeps a " - " that belongs to the show title out of the code', () => {
    // The pre-fix state of the library: a colon in the canonical title
    // rendered as " - ", which is also the structural separator.
    expect(splitStem('Star Trek - Voyager (1995) - s07e09-e10', fileRegex)).toMatchObject({
      prefix: 'Star Trek - Voyager (1995)',
      code: 's07e09-e10',
      title: null,
    })
  })

  it('returns null for a name that does not match the convention', () => {
    expect(splitStem('random file', fileRegex)).toBeNull()
    expect(splitStem('Barry (2018) - 205', fileRegex)).toBeNull()
  })

  it('accepts a 3-digit episode number', () => {
    expect(splitStem('Saturday Night Live (1975) - s00e201', fileRegex)).toMatchObject({
      code: 's00e201',
      seasonNumber: 0,
      episodeStart: 201,
    })
  })

  it('parses an unpadded number only when a fallback regex is supplied', () => {
    expect(splitStem('Shameless (2011) - s02e4', fileRegex)).toBeNull()
    expect(splitStem('Shameless (2011) - s02e4', fileRegex, LENIENT_EPISODE_FILE)).toMatchObject({
      code: 's02e4',
      episodeStart: 4,
    })
  })

  it('round-trips through joinStem unchanged', () => {
    for (const stem of [
      'Barry (2018) - s02e05',
      'Barry (2018) - s02e05 - ronny lily',
      'Star Trek - Voyager (1995) - s07e09-e10',
      "Tom Clancy's Jack Ryan (2018) - s00e04",
    ]) {
      const parts = splitStem(stem, fileRegex)
      expect(parts).not.toBeNull()
      expect(joinStem(parts!)).toBe(stem)
    }
  })
})

// ─────────────────────────────────────────────
// Title sanitization
// ─────────────────────────────────────────────

describe('sanitizeEpisodeTitle', () => {
  it('passes a clean title through untouched', () => {
    expect(sanitizeEpisodeTitle('Pilot')).toBe('Pilot')
  })

  it('drops trailing periods Windows cannot store', () => {
    expect(sanitizeEpisodeTitle('All Good Things...')).toBe('All Good Things')
    expect(sanitizeEpisodeTitle('T.R.A.C.K.S.')).toBe('T.R.A.C.K.S')
  })

  it('deletes illegal characters and collapses the gap they leave', () => {
    expect(sanitizeEpisodeTitle('Chapter Two: The Vanishing')).toBe('Chapter Two The Vanishing')
    expect(sanitizeEpisodeTitle('Who Are You?')).toBe('Who Are You')
  })

  it('returns null when nothing survives', () => {
    expect(sanitizeEpisodeTitle('...')).toBeNull()
    expect(sanitizeEpisodeTitle('   ')).toBeNull()
  })
})

describe('sanitizeEpisodeTitle — path separators', () => {
  it('deletes slashes rather than substituting for them', () => {
    // Deletion, not substitution: it matches stripFilenameIllegalChars, and it
    // keeps the on-disk name equal to TMDB's under the validator's strict tier,
    // which deletes the same characters from the other side.
    expect(sanitizeEpisodeTitle('East/West')).toBe('EastWest')
    expect(sanitizeEpisodeTitle('ronny/lily')).toBe('ronnylily')
    expect(sanitizeEpisodeTitle('White Hat/Black Hat')).toBe('White HatBlack Hat')
    expect(sanitizeEpisodeTitle('The Red/White Blues')).toBe('The RedWhite Blues')
    expect(sanitizeEpisodeTitle('Back\\Slash')).toBe('BackSlash')
  })

  it('collapses the whitespace left when a spaced slash is removed', () => {
    expect(sanitizeEpisodeTitle('Career Day (1) / Career Day (2)')).toBe(
      'Career Day (1) Career Day (2)'
    )
  })
})

// ─────────────────────────────────────────────
// planEpisodeTitles — the season guard
// ─────────────────────────────────────────────

describe('planEpisodeTitles', () => {
  /**
   * Build the walked-file list for one season folder directly, so each case
   * states exactly the filenames and TMDB episode list it is about.
   */
  function runSeason(
    fileNames: string[],
    tmdbEpisodes: Array<[number, string]>,
    allowPartial = false
  ) {
    const files = fileNames.map(fileName => ({
      absDir: `X:/Shows/HD/Show (2020)/Season 01`,
      relDir: 'HD/Show (2020)/Season 01',
      showFolder: 'Show (2020)',
      seasonFolder: 'Season 01',
      fileName,
    }))
    return planEpisodeTitles(
      files,
      fileRegex,
      new Map([['Show (2020)', 100]]),
      new Map([['100:1', new Map(tmdbEpisodes)]]),
      allowPartial
    )
  }

  it('names every untitled file when the season matches TMDB exactly', () => {
    const plan = runSeason(
      ['Show (2020) - s01e01.mp4', 'Show (2020) - s01e02.mp4'],
      [
        [1, 'Pilot'],
        [2, 'Second'],
      ]
    )
    expect(plan.entries.map(e => e.to)).toEqual([
      'Show (2020) - s01e01 - Pilot.mp4',
      'Show (2020) - s01e02 - Second.mp4',
    ])
    expect(plan.skipped).toEqual([])
  })

  it('skips the WHOLE season when a file references an episode TMDB does not list', () => {
    // The MASH case: a recap episode sitting past the end of TMDB's list. The
    // other files would resolve, but the season's numbering is suspect, so
    // none of them are touched.
    const plan = runSeason(
      ['Show (2020) - s01e01.mp4', 'Show (2020) - s01e02.mp4', 'Show (2020) - s01e03.mp4'],
      [
        [1, 'Pilot'],
        [2, 'Second'],
      ]
    )
    expect(plan.entries).toEqual([])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.reason).toMatch(/TMDB doesn't list/)
    expect(plan.skipped[0]!.path).toBe('HD/Show (2020)/Season 01')
  })

  it('skips the whole season when episodes are missing locally', () => {
    const plan = runSeason(
      ['Show (2020) - s01e01.mp4'],
      [
        [1, 'Pilot'],
        [2, 'Second'],
      ]
    )
    expect(plan.entries).toEqual([])
    expect(plan.skipped[0]!.reason).toMatch(/covers 1 of TMDB's 2 episodes/)
  })

  it('names a partial season with allowPartial, noting every entry for review', () => {
    const plan = runSeason(
      ['Show (2020) - s01e01.mp4', 'Show (2020) - s01e03.mp4'],
      [
        [1, 'Pilot'],
        [2, 'Second'],
        [3, 'Third'],
      ],
      true
    )
    expect(plan.skipped).toEqual([])
    expect(plan.entries.map(e => e.to)).toEqual([
      'Show (2020) - s01e01 - Pilot.mp4',
      'Show (2020) - s01e03 - Third.mp4',
    ])
    for (const entry of plan.entries) {
      expect(entry.note).toMatch(/partial season — 2 of 3 TMDB episodes/)
    }
  })

  it('still skips the whole season under allowPartial when a file references an unlisted episode', () => {
    const plan = runSeason(
      ['Show (2020) - s01e01.mp4', 'Show (2020) - s01e05.mp4'],
      [
        [1, 'Pilot'],
        [2, 'Second'],
      ],
      true
    )
    expect(plan.entries).toEqual([])
    expect(plan.skipped[0]!.reason).toMatch(/TMDB doesn't list/)
  })

  it('does not add a partial note to a complete season under allowPartial', () => {
    const plan = runSeason(['Show (2020) - s01e01.mp4'], [[1, 'Pilot']], true)
    expect(plan.entries[0]!.note).toBeUndefined()
  })

  it('counts a multi-episode file as covering every episode it spans', () => {
    // One file + two TMDB episodes still equals a complete season.
    const plan = runSeason(
      ['Show (2020) - s01e01-e02.mp4'],
      [
        [1, 'Part One'],
        [2, 'Part Two'],
      ]
    )
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]!.to).toBe('Show (2020) - s01e01-e02 - Part One + Part Two.mp4')
    expect(plan.entries[0]!.note).toMatch(/multi-episode/)
  })

  it('accepts a two-parter TMDB merged into one numbered episode', () => {
    // Abbott Elementary S3: TMDB numbers 1,3..N with no episode 2, and the
    // local file spans e01-e02. Counting RESOLVED TMDB episodes (not local
    // files, not spanned numbers) is what makes this come out right.
    const plan = runSeason(
      ['Show (2020) - s01e01-e02.mp4', 'Show (2020) - s01e03.mp4'],
      [
        [1, 'Career Day (1) / Career Day (2)'],
        [3, 'Third'],
      ]
    )
    expect(plan.entries).toHaveLength(2)
    expect(plan.entries[0]!.to).toBe('Show (2020) - s01e01-e02 - Career Day (1) Career Day (2).mp4')
  })

  it('leaves already-titled files alone but still counts them toward the guard', () => {
    const plan = runSeason(
      ['Show (2020) - s01e01 - Pilot.mp4', 'Show (2020) - s01e02.mp4'],
      [
        [1, 'Pilot'],
        [2, 'Second'],
      ]
    )
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]!.from).toBe('Show (2020) - s01e02.mp4')
  })

  it('reports the season once, not once per file, when it is skipped', () => {
    const plan = runSeason(
      ['Show (2020) - s01e01.mp4', 'Show (2020) - s01e02.mp4', 'Show (2020) - s01e09.mp4'],
      [[1, 'Pilot']]
    )
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.reason).toMatch(/^3 file\(s\)/)
  })

  it('does nothing for a season whose files all already have titles', () => {
    const plan = runSeason(['Show (2020) - s01e01 - Pilot.mp4'], [[1, 'Pilot']])
    expect(plan.entries).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('skips a season with no cached TMDB data', () => {
    const files = [
      {
        absDir: 'X:/Shows/HD/Show (2020)/Season 09',
        relDir: 'HD/Show (2020)/Season 09',
        showFolder: 'Show (2020)',
        seasonFolder: 'Season 09',
        fileName: 'Show (2020) - s09e01.mp4',
      },
    ]
    const plan = planEpisodeTitles(files, fileRegex, new Map([['Show (2020)', 100]]), new Map())
    expect(plan.entries).toEqual([])
    expect(plan.skipped[0]!.reason).toMatch(/no cached TMDB data for season 9/)
  })

  it('embeds a slash-containing TMDB title with the slash deleted', () => {
    const plan = runSeason(['Show (2020) - s01e01.mp4'], [[1, 'East/West']])
    expect(plan.entries[0]!.to).toBe('Show (2020) - s01e01 - EastWest.mp4')
    expect(plan.review).toEqual([])
  })
})

// ─────────────────────────────────────────────
// planShowPrefix
// ─────────────────────────────────────────────

describe('planShowPrefix', () => {
  const spec: DirSpec = {
    SD: {
      'Star Trek Voyager (1995)': {
        'Season 07': {
          'Star Trek - Voyager (1995) - s07e09-e10.mp4': '',
          'Star Trek - Voyager (1995) - s07e11 - Lineage.mp4': '',
        },
      },
      'TaleSpin (1990)': {
        'Season 01': { 'Talespin (1990) - S01e01.mp4': '' },
      },
      'Already Correct (2020)': {
        'Season 01': { 'Already Correct (2020) - s01e01.mp4': '' },
      },
      'Spider-Noir (2026) [True Hue Color]': {
        'Season 01': {
          'Spider-Noir (2026) - s01e01.mp4': '',
          'Spider-Noir (2026) - s01e02.mp4': '',
        },
      },
      // A Plex edition folder. Its files carry the title and year only — the
      // edition belongs to the show, not to any episode.
      'Spider-Noir (2026) {edition-Authentic Black and White}': {
        'Season 01': {
          'Spider-Noir (2026) - s01e01.mp4': '', // already correct
          'Spider Noir (2026) - s01e02.mp4': '', // wrong prefix, needs the hyphen
        },
      },
    },
  }

  function run() {
    const root = buildLibrary(spec, 'moasys-rename-')
    try {
      // planShowPrefix takes an already-walked file list, so build one the
      // same shape main() hands it.
      const files: Array<{
        absDir: string
        relDir: string
        showFolder: string
        seasonFolder: string
        fileName: string
      }> = []
      for (const show of fs.readdirSync(path.join(root, 'SD'))) {
        const showPath = path.join(root, 'SD', show)
        for (const season of fs.readdirSync(showPath)) {
          const seasonPath = path.join(showPath, season)
          for (const file of fs.readdirSync(seasonPath)) {
            files.push({
              absDir: seasonPath,
              relDir: `SD/${show}/${season}`,
              showFolder: show,
              seasonFolder: season,
              fileName: file,
            })
          }
        }
      }
      return planShowPrefix(
        files,
        fileRegex,
        compilePattern(defaultShowsRules.patterns.show_folder)
      )
    } finally {
      cleanupLibrary(root)
    }
  }

  it('rewrites the prefix to the folder name and preserves everything after it', () => {
    const plan = run()
    const byFrom = new Map(plan.entries.map(e => [e.from, e.to]))

    expect(byFrom.get('Star Trek - Voyager (1995) - s07e09-e10.mp4')).toBe(
      'Star Trek Voyager (1995) - s07e09-e10.mp4'
    )
    // Existing episode title and the odd code casing both survive untouched.
    expect(byFrom.get('Star Trek - Voyager (1995) - s07e11 - Lineage.mp4')).toBe(
      'Star Trek Voyager (1995) - s07e11 - Lineage.mp4'
    )
    expect(byFrom.get('Talespin (1990) - S01e01.mp4')).toBe('TaleSpin (1990) - S01e01.mp4')
  })

  it('plans nothing for files whose prefix already matches — so a re-run is a no-op', () => {
    const plan = run()
    expect(plan.entries.some(e => e.from.startsWith('Already Correct'))).toBe(false)
    expect(plan.entries).toHaveLength(4)
  })

  it('never copies an invalid show folder name into its files', () => {
    const plan = run()
    expect(plan.entries.some(e => e.dir.includes('[True Hue Color]'))).toBe(false)
    expect(plan.review).toEqual([
      {
        path: 'SD/Spider-Noir (2026) [True Hue Color]',
        reason: expect.stringContaining('does not match patterns.show_folder'),
      },
    ])
  })

  /**
   * Plex keeps an edition on the show folder and off the episode files, so the
   * prefix is rebuilt from the folder's parsed title and year — never from the
   * folder name. Copying the name verbatim would push `{edition-…}` onto every
   * file and break the match.
   */
  it('strips the edition tag when rebuilding the prefix', () => {
    const plan = run()
    const editionEntries = plan.entries.filter(e => e.dir.includes('{edition-'))

    expect(editionEntries).toEqual([
      {
        dir: 'SD/Spider-Noir (2026) {edition-Authentic Black and White}/Season 01',
        from: 'Spider Noir (2026) - s01e02.mp4',
        to: 'Spider-Noir (2026) - s01e02.mp4',
      },
    ])
    expect(plan.entries.every(e => !e.to.includes('{edition-'))).toBe(true)
    // The already-correct file in that folder is left alone, so a re-run after
    // an apply plans nothing here.
    expect(plan.entries.some(e => e.from === 'Spider-Noir (2026) - s01e01.mp4')).toBe(false)
  })
})

// ─────────────────────────────────────────────
// planEpisodeCode
// ─────────────────────────────────────────────

describe('planEpisodeCode', () => {
  function run(fileNames: string[]) {
    const files = fileNames.map(fileName => ({
      absDir: 'X:/Shows/HD/Show (2020)/Season 02',
      relDir: 'HD/Show (2020)/Season 02',
      showFolder: 'Show (2020)',
      seasonFolder: 'Season 02',
      fileName,
    }))
    return planEpisodeCode(files, fileRegex, { episode_code_case: 'lower' })
  }

  it('restyles the case and pads an unpadded episode number', () => {
    const plan = run([
      'Show (2020) - S02e01.mp4',
      'Show (2020) - s02e4.mp4',
      'Show (2020) - s02e05.mp4',
    ])
    expect(plan.entries.map(e => e.to)).toEqual([
      'Show (2020) - s02e01.mp4',
      'Show (2020) - s02e04.mp4',
    ])
  })

  it('fixes an over-padded season and a missing separator space', () => {
    const plan = run([
      'Cheers (1982) - S010e01.mp4',
      'Diners, Drive-Ins And Dives (2006) -S01e01.mp4',
    ])
    expect(plan.entries.map(e => e.to)).toEqual([
      'Cheers (1982) - s10e01.mp4',
      'Diners, Drive-Ins And Dives (2006) - s01e01.mp4',
    ])
  })

  it('still ignores codes it cannot read', () => {
    const plan = run([
      'Show (2020) - S02e 07.mp4',
      'Show (2020) - s02e05q.mp4',
      'Show (2020) - s01emany.mp4',
      'Show - s00e01.mp4',
    ])
    expect(plan.entries).toEqual([])
  })

  it('leaves a 3-digit episode number unpadded', () => {
    expect(run(['Show (2020) - S00E201.mp4']).entries[0]!.to).toBe('Show (2020) - s00e201.mp4')
  })

  it('sends a backwards episode range to review instead of renaming it', () => {
    const plan = run(['Show (2020) - s00e110-010.mp4'])
    expect(plan.entries).toEqual([])
    expect(plan.review[0]!.reason).toMatch(/runs backwards/)
  })
})

// ─────────────────────────────────────────────
// planShowFolder
// ─────────────────────────────────────────────

describe('planShowFolder', () => {
  const rules: Parameters<typeof planShowFolder>[1] = {
    categories: [{ name: 'HD' }, { name: 'SD' }],
    patterns: defaultShowsRules.patterns,
  }

  it('plans one folder entry per category that holds the show', () => {
    const root = buildLibrary(
      {
        HD: { 'Saved by Bell (1989)': {} },
        SD: { 'Saved by Bell (1989)': {}, 'Other (2000)': {} },
      },
      'moasys-folder-'
    )
    try {
      const { built, problems } = planShowFolder(
        root,
        rules,
        'Saved by Bell (1989)',
        'Saved by the Bell (1989)'
      )
      expect(problems).toEqual([])
      expect(built.entries).toEqual([
        { dir: 'HD', from: 'Saved by Bell (1989)', to: 'Saved by the Bell (1989)', kind: 'folder' },
        { dir: 'SD', from: 'Saved by Bell (1989)', to: 'Saved by the Bell (1989)', kind: 'folder' },
      ])
      expect(validatePlan(makePlan(built.entries), root)).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('requires an exact-case source name', () => {
    const root = buildLibrary({ HD: { 'ALF (1986)': {} } }, 'moasys-folder-')
    try {
      const { built, problems } = planShowFolder(root, rules, 'alf (1986)', 'Alf (1986)')
      expect(built.entries).toEqual([])
      expect(problems).toEqual([
        expect.stringContaining("no show folder named exactly 'alf (1986)'"),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('rejects a target that is not a valid show folder name', () => {
    const root = buildLibrary({ HD: { 'Show (2020)': {} } }, 'moasys-folder-')
    try {
      expect(planShowFolder(root, rules, 'Show (2020)', 'Show 2020').problems).toEqual([
        expect.stringContaining('does not match patterns.show_folder'),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('allows a case-only folder rename but rejects an existing sibling', () => {
    const root = buildLibrary(
      { HD: { 'Whose Line Is it Anyway (1998)': {}, 'Taken (2020)': {}, 'Show (2020)': {} } },
      'moasys-folder-'
    )
    try {
      const caseOnly = planShowFolder(
        root,
        rules,
        'Whose Line Is it Anyway (1998)',
        'Whose Line Is It Anyway (1998)'
      )
      expect([
        ...caseOnly.problems,
        ...validatePlan(makePlan(caseOnly.built.entries), root),
      ]).toEqual([])

      const collide = planShowFolder(root, rules, 'Show (2020)', 'Taken (2020)')
      expect(validatePlan(makePlan(collide.built.entries), root)).toEqual([
        expect.stringContaining('already exists'),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('checks path length against the deepest file after the rename', () => {
    const deepName = `${'x'.repeat(150)}.mp4`
    const root = buildLibrary(
      { HD: { 'Show (2020)': { 'Season 01': { [deepName]: '' } } } },
      'moasys-folder-'
    )
    try {
      const { built } = planShowFolder(root, rules, 'Show (2020)', `${'Long '.repeat(12)}(2020)`)
      expect(validatePlan(makePlan(built.entries), root)).toEqual([
        expect.stringContaining('chars (max 240)'),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })
})

// ─────────────────────────────────────────────
// validatePlan
// ─────────────────────────────────────────────

describe('validatePlan', () => {
  it('accepts a clean plan', () => {
    const root = buildLibrary({ 'a.mp4': '' }, 'moasys-validate-')
    try {
      expect(validatePlan(makePlan([{ dir: '', from: 'a.mp4', to: 'b.mp4' }]), root)).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('rejects a target that would escape its directory', () => {
    const problems = validatePlan(
      makePlan([{ dir: 'SD', from: 'a.mp4', to: '../b.mp4' }]),
      'X:\\Shows'
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('illegal character')
  })

  it('rejects two entries claiming the same target', () => {
    const problems = validatePlan(
      makePlan([
        { dir: 'SD', from: 'a.mp4', to: 'same.mp4' },
        { dir: 'SD', from: 'b.mp4', to: 'same.mp4' },
      ]),
      'X:\\Shows'
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('already claimed')
  })

  it('rejects a target that already exists on disk', () => {
    const root = buildLibrary({ 'a.mp4': '', 'b.mp4': '' }, 'moasys-validate-')
    try {
      const problems = validatePlan(makePlan([{ dir: '', from: 'a.mp4', to: 'b.mp4' }]), root)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('already exists')
    } finally {
      cleanupLibrary(root)
    }
  })

  it('does NOT treat a case-only rename as a collision with itself', () => {
    // On a case-insensitive filesystem the source IS the target as far as
    // existsSync is concerned. Without the carve-out every case fix aborts.
    const root = buildLibrary({ 'talespin.mp4': '' }, 'moasys-validate-')
    try {
      expect(
        validatePlan(makePlan([{ dir: '', from: 'talespin.mp4', to: 'TaleSpin.mp4' }]), root)
      ).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('rejects a target path over the length ceiling', () => {
    const problems = validatePlan(
      makePlan([{ dir: 'SD', from: 'a.mp4', to: `${'x'.repeat(250)}.mp4` }]),
      'X:\\Shows'
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('chars (max 240)')
  })
})

// ─────────────────────────────────────────────
// renameFile
// ─────────────────────────────────────────────

describe('renameFile', () => {
  it('renames a file normally', () => {
    const root = buildLibrary({ 'a.mp4': 'content' }, 'moasys-rename-fs-')
    try {
      renameFile(path.join(root, 'a.mp4'), path.join(root, 'b.mp4'))
      expect(fs.readdirSync(root)).toEqual(['b.mp4'])
      expect(fs.readFileSync(path.join(root, 'b.mp4'), 'utf-8')).toBe('content')
    } finally {
      cleanupLibrary(root)
    }
  })

  it('actually applies a case-only rename', () => {
    // Asserts the observable result, not merely that nothing threw. A plain
    // fs.renameSync is a SILENT no-op for a case-only rename on some
    // case-insensitive filesystems (exFAT among them) — it reports success
    // and changes nothing, which shipped once as 726 reported renames with
    // 174 files untouched.
    //
    // Caveat worth knowing: temp dirs here are usually NTFS, which handles
    // the direct rename fine, so this passes either way on most machines.
    // It locks in the right assertion; the rollback and staging-file tests
    // below are the ones that exercise the two-step path everywhere.
    const root = buildLibrary({ 'talespin.mp4': 'content' }, 'moasys-rename-fs-')
    try {
      renameFile(path.join(root, 'talespin.mp4'), path.join(root, 'TaleSpin.mp4'))
      expect(fs.readdirSync(root)).toEqual(['TaleSpin.mp4'])
      expect(fs.readFileSync(path.join(root, 'TaleSpin.mp4'), 'utf-8')).toBe('content')
    } finally {
      cleanupLibrary(root)
    }
  })

  it('leaves no staging file behind after a case-only rename', () => {
    const root = buildLibrary({ 'talespin.mp4': '' }, 'moasys-rename-fs-')
    try {
      renameFile(path.join(root, 'talespin.mp4'), path.join(root, 'TaleSpin.mp4'))
      expect(fs.readdirSync(root).filter(f => f.includes('__moasys_case__'))).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('restores the original name when a case-only rename cannot complete', () => {
    // The failure is injected rather than staged on disk: a case-only rename
    // has no constructible on-disk blocker, because any path that would block
    // the target IS the source file on a case-insensitive filesystem.
    const root = buildLibrary({ 'talespin.mp4': '' }, 'moasys-rename-fs-')
    const real = fs.renameSync
    let call = 0
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      call++
      if (call === 2) throw new Error('injected failure on the staging → target step')
      return real(from, to)
    })

    try {
      expect(() =>
        renameFile(path.join(root, 'talespin.mp4'), path.join(root, 'TaleSpin.mp4'))
      ).toThrow('injected failure')

      // Three calls: source → staging, the failed staging → target, and the
      // rollback staging → source.
      expect(call).toBe(3)
      expect(fs.readdirSync(root)).toEqual(['talespin.mp4'])
    } finally {
      spy.mockRestore()
      cleanupLibrary(root)
    }
  })
})

// ─────────────────────────────────────────────
// validateUndoManifest
// ─────────────────────────────────────────────

describe('validateUndoManifest', () => {
  const manifest = (renames: Array<{ from: string; to: string; kind?: 'file' | 'folder' }>) => ({
    generated: '2026-01-01T00:00:00.000Z',
    fix: 'show-prefix',
    drive: 'Test',
    renames,
  })

  it('accepts a manifest written by --apply after the renames happened', () => {
    const root = buildLibrary({ 'new.mp4': '' }, 'moasys-undo-')
    try {
      const m = manifest([{ from: path.join(root, 'old.mp4'), to: path.join(root, 'new.mp4') }])
      expect(validateUndoManifest(m)).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('accepts a case-only rename even though the original name "exists"', () => {
    const root = buildLibrary({ 'TaleSpin.mp4': '' }, 'moasys-undo-')
    try {
      const m = manifest([
        { from: path.join(root, 'talespin.mp4'), to: path.join(root, 'TaleSpin.mp4') },
      ])
      expect(validateUndoManifest(m)).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('refuses to overwrite a file that now sits at the original name', () => {
    const root = buildLibrary({ 'old.mp4': 'someone else', 'new.mp4': '' }, 'moasys-undo-')
    try {
      const m = manifest([{ from: path.join(root, 'old.mp4'), to: path.join(root, 'new.mp4') }])
      expect(validateUndoManifest(m)).toEqual([
        expect.stringContaining('already exists — undoing would overwrite it'),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('refuses to move a file between folders', () => {
    const root = buildLibrary({ 'Season 01': { 'a.mp4': '' }, 'Season 02': {} }, 'moasys-undo-')
    try {
      const m = manifest([
        { from: path.join(root, 'Season 02', 'a.mp4'), to: path.join(root, 'Season 01', 'a.mp4') },
      ])
      expect(validateUndoManifest(m)).toEqual([expect.stringContaining('between folders')])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('refuses two entries that restore to the same name', () => {
    const root = buildLibrary({ 'b.mp4': '', 'c.mp4': '' }, 'moasys-undo-')
    try {
      const m = manifest([
        { from: path.join(root, 'a.mp4'), to: path.join(root, 'b.mp4') },
        { from: path.join(root, 'A.mp4'), to: path.join(root, 'c.mp4') },
      ])
      expect(validateUndoManifest(m)).toEqual([expect.stringContaining('is also restored by')])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('refuses relative paths, folders, and malformed manifests', () => {
    const root = buildLibrary({ Folder: {} }, 'moasys-undo-')
    try {
      expect(validateUndoManifest(manifest([{ from: 'a.mp4', to: 'b.mp4' }]))).toEqual([
        expect.stringContaining('must be absolute'),
      ])
      expect(
        validateUndoManifest(
          manifest([{ from: path.join(root, 'Renamed'), to: path.join(root, 'Folder') }])
        )
      ).toEqual([expect.stringContaining('is not a file')])
      expect(validateUndoManifest({ nope: true })).toEqual([
        'not an undo manifest (no "renames" list)',
      ])
      expect(validateUndoManifest(manifest([{ from: 1, to: null } as never]))).toEqual([
        expect.stringContaining('must both be file paths'),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('accepts a folder entry, but only when it is marked as a folder', () => {
    const root = buildLibrary({ HD: { 'New (2020)': {}, 'file.mp4': '' } }, 'moasys-undo-')
    try {
      const folder = {
        from: path.join(root, 'HD', 'Old (2020)'),
        to: path.join(root, 'HD', 'New (2020)'),
        kind: 'folder' as const,
      }
      expect(validateUndoManifest(manifest([folder]))).toEqual([])
      expect(
        validateUndoManifest(manifest([{ ...folder, to: path.join(root, 'HD', 'file.mp4') }]))
      ).toEqual([expect.stringContaining('is not a folder')])
      expect(validateUndoManifest(manifest([{ from: folder.from, to: folder.to }]))).toEqual([
        expect.stringContaining('is not a file'),
      ])
    } finally {
      cleanupLibrary(root)
    }
  })

  it('still allows entries whose renamed file is already gone (a partial run)', () => {
    const root = buildLibrary({}, 'moasys-undo-')
    try {
      const m = manifest([{ from: path.join(root, 'old.mp4'), to: path.join(root, 'new.mp4') }])
      expect(validateUndoManifest(m)).toEqual([])
    } finally {
      cleanupLibrary(root)
    }
  })
})
