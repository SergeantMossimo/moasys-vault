import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { PROJECT_ROOT } from '../../../src/core/project'
import {
  NO_IGNORE_FLAG,
  noIgnoreRequested,
  probeFilePaths,
  warningsPath,
} from '../../../src/plex/run-shared'

describe('probeFilePaths', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function probeFile(data: unknown): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-plex-run-shared-'))
    const p = path.join(tmpDir, 'probe.json')
    fs.writeFileSync(p, JSON.stringify(data))
    return p
  }

  it('reads every file path out of each media type’s probe shape', () => {
    expect(
      probeFilePaths('movies', probeFile([{ files: [{ path: 'HD/A (2000)/A (2000).mkv' }] }]))
    ).toEqual(['HD/A (2000)/A (2000).mkv'])

    expect(
      probeFilePaths(
        'shows',
        probeFile([{ seasons: [{ episodes: [{ path: 'S/e1.mkv' }, { path: 'S/e2.mkv' }] }] }])
      )
    ).toEqual(['S/e1.mkv', 'S/e2.mkv'])

    expect(
      probeFilePaths('music', probeFile([{ albums: [{ tracks: [{ path: 'A/B/01.flac' }] }] }]))
    ).toEqual(['A/B/01.flac'])

    expect(
      probeFilePaths('audiobooks', probeFile([{ chapters: [{ path: 'A/B/01.mp3' }] }]))
    ).toEqual(['A/B/01.mp3'])
  })
})

describe('noIgnoreRequested', () => {
  it('is true only when the flag is on the command line', () => {
    expect(noIgnoreRequested(['--all', NO_IGNORE_FLAG])).toBe(true)
    expect(noIgnoreRequested(['--all', 'external'])).toBe(false)
  })
})

describe('warningsPath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes to the type folder, or to unfiltered/ for a --no-ignore run', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const root = { name: 'Server', root_path: 'M:\\Shows' }
    const dir = path.join(PROJECT_ROOT, 'output', 'server', 'shows')

    expect(warningsPath(root, 'shows', 'plexWarnings', false)).toBe(
      path.join(dir, 'plex-warnings.json')
    )
    expect(warningsPath(root, 'shows', 'plexLogWarnings', true)).toBe(
      path.join(dir, 'unfiltered', 'plex-log-warnings.json')
    )
  })
})
