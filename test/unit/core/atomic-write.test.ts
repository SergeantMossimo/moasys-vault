import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { writeFileAtomic } from '../../../src/core/atomic-write'

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
})
