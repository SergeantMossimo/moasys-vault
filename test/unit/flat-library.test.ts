/**
 * A library with no category folders — `root_path` holds the titles directly
 * (`D:\Movies\Heat (1995)\Heat (1995).mp4`), which is what the shipped rules
 * (`categories: []`) expect. Each type's probe and scan passes run against
 * one such library end to end, the way `npm run <type>` does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { DirReader } from '../../src/core/dir-reader'
import { parseIgnoreList } from '../../src/core/ignored'
import { scan } from '../../src/core/scanner'
import { WarningCollector } from '../../src/core/types'
import { defaultAudiobooksRules } from '../../src/core/rules/audiobooks'
import { defaultMoviesRules } from '../../src/core/rules/movies'
import { defaultMusicRules } from '../../src/core/rules/music'
import { defaultShowsRules } from '../../src/core/rules/shows'
import { createAudiobooksModule } from '../../src/media/audiobooks'
import { createMoviesModule } from '../../src/media/movies'
import { createMusicModule } from '../../src/media/music'
import { createShowsModule } from '../../src/media/shows'
import { ProbeCache } from '../../src/probe/cache'
import { probeAudiobooks } from '../../src/probe/audiobooks'
import { probeMovies } from '../../src/probe/movies'
import { probeMusic } from '../../src/probe/music'
import { probeShows } from '../../src/probe/shows'
import { ProbeData } from '../../src/probe/types'
import { buildLibrary, cleanupLibrary, fakeProbe, type DirSpec } from '../fixtures/library'

let root: string
let cacheDir: string

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-flat-cache-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupLibrary(root)
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

/** A cache primed for every file in the library, so no real ffprobe runs. */
function primedCache(files: string[]): ProbeCache {
  const cache = new ProbeCache(path.join(cacheDir, 'probe.json'))
  for (const rel of files) {
    const stat = fs.statSync(path.join(root, rel))
    const data: ProbeData = { ...fakeProbe(), tags_read: true }
    cache.set(rel, stat.mtimeMs, stat.size, data)
  }
  return cache
}

function setup(spec: DirSpec, files: string[]) {
  root = buildLibrary(spec, 'moasys-flat-')
  return { cache: primedCache(files), dir: new DirReader() }
}

describe('a library with no category folders', () => {
  it('movies: catalogs and probes titles straight under root_path', async () => {
    const file = 'Heat (1995)/Heat (1995).mp4'
    const { cache, dir } = setup({ 'Heat (1995)': { 'Heat (1995).mp4': '' } }, [file])
    const rules = { ...defaultMoviesRules, categories: [] }
    const warnings = new WarningCollector(undefined, false)

    const probe = await probeMovies({ root_path: root }, rules, cache, warnings, dir)
    const records = scan(
      { root_path: root },
      createMoviesModule(rules),
      warnings,
      probe.byPath,
      dir
    )

    expect([...probe.byPath.keys()]).toEqual([file])
    expect([...records.values()].map(r => [r.title, r.versions[0]?.category])).toEqual([
      ['Heat', 'default'],
    ])
    expect(warnings.all()).toEqual([])
  })

  it('shows: catalogs and probes Show/Season/episode under root_path', async () => {
    const file = 'Firefly (2002)/Season 01/Firefly (2002) - S01E01 - Serenity.mp4'
    const { cache, dir } = setup(
      { 'Firefly (2002)': { 'Season 01': { 'Firefly (2002) - S01E01 - Serenity.mp4': '' } } },
      [file]
    )
    const rules = { ...defaultShowsRules, categories: [] }
    const warnings = new WarningCollector(undefined, false)

    const probe = await probeShows({ root_path: root }, rules, cache, warnings, dir)
    const records = scan({ root_path: root }, createShowsModule(rules), warnings, probe.byPath, dir)

    expect([...probe.byPath.keys()]).toEqual([file])
    expect([...records.values()].map(r => r.title)).toEqual(['Firefly'])
    expect(warnings.all()).toEqual([])
  })

  it('music: catalogs and probes Artist/Album/track under root_path', async () => {
    const file = 'Artist/Album/01 - Song.flac'
    const { cache, dir } = setup({ Artist: { Album: { '01 - Song.flac': '' } } }, [file])
    const rules = { ...defaultMusicRules, categories: [] }
    const warnings = new WarningCollector(undefined, false)

    const probe = await probeMusic({ root_path: root }, rules, cache, warnings, dir)
    const records = scan({ root_path: root }, createMusicModule(rules), warnings, probe.byPath, dir)

    expect([...probe.byPath.keys()]).toEqual([file])
    expect([...records.values()].map(r => r.artist)).toEqual(['Artist'])
  })

  it('audiobooks: catalogs and probes Author/Book/chapter under root_path', async () => {
    const file = 'Andy Weir/The Martian/01 - Chapter.mp3'
    const { cache, dir } = setup({ 'Andy Weir': { 'The Martian': { '01 - Chapter.mp3': '' } } }, [
      file,
    ])
    const rules = { ...defaultAudiobooksRules, categories: [] }
    const warnings = new WarningCollector(undefined, false)

    const probe = await probeAudiobooks({ root_path: root }, rules, cache, warnings, dir)
    const module = createAudiobooksModule(rules)
    const books = module.serialize(scan({ root_path: root }, module, warnings, probe.byPath, dir))

    expect([...probe.byPath.keys()]).toEqual([file])
    expect(books.map(b => [b.title, b.author_folder])).toEqual([['The Martian', 'Andy Weir']])
  })

  it('reports loose files at the top as path ".", silenced by `folders: [.]`', () => {
    root = buildLibrary(
      { 'stray.mp4': '', 'Heat (1995)': { 'Heat (1995).mp4': '' } },
      'moasys-flat-'
    )
    const rules = { ...defaultMoviesRules, categories: [] }

    const loud = new WarningCollector(undefined, false)
    scan({ root_path: root }, createMoviesModule(rules), loud, new Map())
    expect(loud.all().map(w => [w.type, w.path])).toEqual([['warn_loose_files', '.']])

    const quiet = new WarningCollector(
      parseIgnoreList({ folders: ['.'] }, 'movies', 't.yaml'),
      false
    )
    scan({ root_path: root }, createMoviesModule(rules), quiet, new Map())
    expect(quiet.all()).toEqual([])
  })
})
