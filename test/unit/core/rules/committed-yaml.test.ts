import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ZodType } from 'zod'

import { loadRules } from '../../../../src/core/rules/loader'
import { MoviesRulesSchema, defaultMoviesRules } from '../../../../src/core/rules/movies'
import { ShowsRulesSchema, defaultShowsRules } from '../../../../src/core/rules/shows'
import { MusicRulesSchema, defaultMusicRules } from '../../../../src/core/rules/music'
import {
  AudiobooksRulesSchema,
  defaultAudiobooksRules,
} from '../../../../src/core/rules/audiobooks'
import { PlexRulesSchema, defaultPlexRules } from '../../../../src/core/rules/plex'

/**
 * `rules/<type>.yaml` is documented as the committed snapshot of the code
 * defaults. Nothing enforced that, and the two drifted — personal values
 * (narrowed sidecar lists, flipped toggles) landed in the committed files.
 *
 * Each case loads the committed YAML on its own, from a temp project root so
 * this machine's gitignored `rules/<type>.local.yaml` can't leak in, and
 * compares the result with the code defaults loaded the same way. Going
 * through `loadRules` for both sides normalizes the representational
 * differences (string patterns vs `{ pattern, flags }`, `max: current`).
 *
 * If this fails, decide which side is the intended default and change the
 * other. Personal values belong in `rules/<type>.local.yaml`.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..')

const TYPES: Array<{ mediaType: string; schema: ZodType<unknown>; defaults: unknown }> = [
  { mediaType: 'movies', schema: MoviesRulesSchema, defaults: defaultMoviesRules },
  { mediaType: 'shows', schema: ShowsRulesSchema, defaults: defaultShowsRules },
  { mediaType: 'music', schema: MusicRulesSchema, defaults: defaultMusicRules },
  { mediaType: 'audiobooks', schema: AudiobooksRulesSchema, defaults: defaultAudiobooksRules },
  { mediaType: 'plex', schema: PlexRulesSchema, defaults: defaultPlexRules },
]

describe('committed rules/<type>.yaml matches the code defaults', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-committed-yaml-'))
    fs.mkdirSync(path.join(tmpDir, 'rules'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it.each(TYPES)('$mediaType', ({ mediaType, schema, defaults }) => {
    const fromCode = loadRules({ mediaType, schema, defaults, projectRoot: tmpDir })

    fs.copyFileSync(
      path.join(REPO_ROOT, 'rules', `${mediaType}.yaml`),
      path.join(tmpDir, 'rules', `${mediaType}.yaml`)
    )
    const fromYaml = loadRules({ mediaType, schema, defaults, projectRoot: tmpDir })

    expect(fromYaml).toEqual(fromCode)
  })
})
