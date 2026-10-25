import { describe, it, expect, afterEach } from 'vitest'

import { runProcess } from '../../../src/probe/ffprobe'

/** Run a short Node script as the child process. */
const node = (script: string, timeoutMs = 10_000) =>
  runProcess(process.execPath, ['-e', script], timeoutMs)

describe('runProcess', () => {
  afterEach(() => {
    delete process.env.FFREPORT
  })

  it('returns stdout on success', async () => {
    await expect(node('process.stdout.write("ok")')).resolves.toBe('ok')
  })

  it('rejects with stderr on a non-zero exit', async () => {
    await expect(node('console.error("bad file"); process.exit(3)')).rejects.toThrow(
      'exited 3: bad file'
    )
  })

  it('kills a child that runs too long instead of hanging the run', async () => {
    await expect(node('setTimeout(() => {}, 60_000)', 200)).rejects.toThrow('timed out')
  })

  it('keeps a multi-byte character intact when it is split across chunks', async () => {
    // "é" is two bytes in UTF-8; write them as two separate chunks.
    const script =
      'process.stdout.write(Buffer.from([0xc3]));' +
      'setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)'
    await expect(node(script)).resolves.toBe('é')
  })

  it('does not pass FFREPORT through, so ffprobe never writes a log file', async () => {
    process.env.FFREPORT = 'file=report.log'
    await expect(node('process.stdout.write(String(process.env.FFREPORT))')).resolves.toBe(
      'undefined'
    )
  })
})
