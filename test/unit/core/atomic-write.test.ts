import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { assertProjectPath, writeFileAtomic } from '../../../src/core/atomic-write'
import { PROJECT_ROOT } from '../../../src/core/project'

describe('writeFileAtomic', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-atomic-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates parent folders and writes the contents', () => {
    const file = path.join(tmpDir, 'nested', 'deeper', 'out.json')
    writeFileAtomic(file, '{"a":1}')
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":1}')
  })

  it('replaces an existing file and leaves no temp file behind', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(file, 'old')
    writeFileAtomic(file, 'new')
    expect(fs.readFileSync(file, 'utf-8')).toBe('new')
    expect(fs.readdirSync(tmpDir)).toEqual(['cache.json'])
  })

  it('writes binary contents unchanged', () => {
    const file = path.join(tmpDir, 'logs.zip')
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00])
    writeFileAtomic(file, bytes)
    expect(new Uint8Array(fs.readFileSync(file))).toEqual(bytes)
  })

  it('keeps the previous file intact when the swap fails', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(file, 'previous')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('disk gone'), { code: 'EIO' })
    })

    expect(() => writeFileAtomic(file, 'half-written')).toThrow('disk gone')
    expect(fs.readFileSync(file, 'utf-8')).toBe('previous')
    expect(fs.readdirSync(tmpDir)).toEqual(['cache.json'])
  })

  it('falls back to writing in place when Windows keeps the file locked', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(file, 'previous')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' })
    })

    writeFileAtomic(file, 'new')
    expect(rename).toHaveBeenCalledTimes(5)
    expect(fs.readFileSync(file, 'utf-8')).toBe('new')
    expect(fs.readdirSync(tmpDir)).toEqual(['cache.json'])
  })

  it('cleans up the temp file when the in-place fallback fails too', () => {
    const file = path.join(tmpDir, 'cache.json')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    })
    const realWrite = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, opts) => {
      if (target === file) throw Object.assign(new Error('still locked'), { code: 'EBUSY' })
      realWrite(target, data, opts)
    })

    expect(() => writeFileAtomic(file, 'new')).toThrow('still locked')
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })
})

describe('assertProjectPath', () => {
  it('allows files inside the project folder', () => {
    expect(() =>
      assertProjectPath(path.join(PROJECT_ROOT, 'output', 'server', 'x.json'))
    ).not.toThrow()
  })

  it('refuses anything outside it, such as a media library', () => {
    const outside = path.join(path.parse(PROJECT_ROOT).root, 'Media', 'Movies', 'x.json')
    expect(() => assertProjectPath(outside)).toThrow('never writes to a media library')
    expect(() => writeFileAtomic(outside, 'x')).toThrow('never writes to a media library')
  })

  it('refuses a path that climbs out with ..', () => {
    expect(() => assertProjectPath(path.join(PROJECT_ROOT, '..', 'elsewhere.json'))).toThrow()
  })

  it('refuses the project folder itself', () => {
    expect(() => assertProjectPath(PROJECT_ROOT)).toThrow()
  })
})
