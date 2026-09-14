import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

import {
  LogFile,
  componentOf,
  extractEvents,
  libraryPathFinder,
  normalizeSignature,
  parseLogLines,
  readLogArchive,
} from '../../../src/plex/log-parser'

const findPath = libraryPathFinder(['/media/Shows', '/media/Movies'])

function logFile(lines: string[], family = 'Plex Media Server'): LogFile {
  return { name: `${family}.log`, family, text: lines.join('\n') }
}

/** A log line on thread `t` at second `s` past 04:04. */
const at = (s: number, t: string, level: string, message: string) =>
  `Sep 14, 2026 04:04:${String(s).padStart(2, '0')}.500 [${t}] ${level} - ${message}`

describe('readLogArchive', () => {
  it('keeps only server and scanner logs, including rotated ones in sub-folders', () => {
    const zip = zipSync({
      'Plex Media Server.log': strToU8('server'),
      'Plex Media Server.3.log': strToU8('rotated'),
      'Plex Media Scanner Analysis.1.log': strToU8('scanner'),
      'Plex Crash Uploader.log': strToU8('no'),
      'Plex Transcoder Statistics.log': strToU8('no'),
      'PMS Plugin Logs/com.plexapp.system.log': strToU8('no'),
    })
    const files = readLogArchive(zip)
    expect(files.map(f => [f.name, f.family, f.text])).toEqual([
      ['Plex Media Scanner Analysis.1.log', 'Plex Media Scanner Analysis', 'scanner'],
      ['Plex Media Server.3.log', 'Plex Media Server', 'rotated'],
      ['Plex Media Server.log', 'Plex Media Server', 'server'],
    ])
  })
})

describe('parseLogLines', () => {
  it('parses the line format into a sortable timestamp', () => {
    const [line] = parseLogLines(
      'Sep 13, 2026 20:03:08.777 [139873737083704] ERROR - [Req#1f0a2] Unknown metadata type: folder'
    )
    expect(line).toEqual({
      timestamp: '2026-09-13 20:03:08.777',
      thread: '139873737083704',
      level: 'ERROR',
      message: '[Req#1f0a2] Unknown metadata type: folder',
    })
  })

  it('folds continuation lines into the line before', () => {
    const lines = parseLogLines(
      [
        at(1, '1', 'ERROR', 'first'),
        '  detail one',
        '',
        'detail two',
        at(2, '1', 'INFO', 'next'),
      ].join('\r\n')
    )
    expect(lines.map(l => l.message)).toEqual(['first\n  detail one\ndetail two', 'next'])
  })
})

describe('componentOf / normalizeSignature', () => {
  it('reads the component without request ids', () => {
    expect(componentOf('[Req#effb/PhotoTranscoder/Req#f3] Format [JPEG] - bad')).toBe(
      'PhotoTranscoder'
    )
    expect(componentOf('[CreditsDetectionManager] failed')).toBe('CreditsDetectionManager')
    expect(componentOf('NAT: PMP, got an error')).toBeNull()
  })

  it('groups repeats of one problem under one signature', () => {
    expect(
      normalizeSignature(
        '[CreditsDetectionManager] Credits detection for item 77957 has failed too many times'
      )
    ).toBe(
      normalizeSignature(
        '[CreditsDetectionManager] Credits detection for item 12 has failed too many times'
      )
    )
    expect(normalizeSignature('[Req#1f0a2] Unknown metadata type: folder')).toBe(
      'Unknown metadata type: folder'
    )
    expect(
      normalizeSignature(
        `Error resizing an image ["/config/Library/Cache/PhotoTranscoder/4f/4f1a2b3c4d5e.jpg"]`
      )
    ).toBe('Error resizing an image [<path>]')
    expect(
      normalizeSignature('Invalid library metadata ID plex://show/5d9c08,plex://movie/5d77 passed.')
    ).toBe('Invalid library metadata ID <guids> passed.')
  })
})

describe('libraryPathFinder', () => {
  it('finds a path with spaces up to a quote, bracket, or line end', () => {
    const ep =
      '/media/Shows/Other HD/Cougar Town (2009)/Season 02/Cougar Town (2009) - s02e01 - All Mixed Up.mp4'
    expect(findPath(`[MI] Opening input file: "${ep}"`)).toBe(ep)
    expect(findPath(`Updating part with ID=1 [${ep}]`)).toBe(ep)
    expect(findPath(`Media part analysis: ${ep}`)).toBe(ep)
    expect(findPath('NAT: PMP, got an error: Not Supported by gateway.')).toBeNull()
  })
})

describe('extractEvents', () => {
  it('keeps only ERROR and WARN lines', () => {
    const events = extractEvents(
      logFile([
        at(1, '1', 'DEBUG', 'x'),
        at(2, '1', 'INFO', 'y'),
        at(3, '1', 'WARN', 'z'),
        at(4, '1', 'ERROR', 'w'),
      ]),
      findPath
    )
    expect(events.map(e => e.level)).toEqual(['WARN', 'ERROR'])
  })

  it('takes an item id from the line itself', () => {
    const [event] = extractEvents(
      logFile([
        at(
          1,
          '9',
          'ERROR',
          '[CreditsDetectionManager] Credits detection for item 77957 has failed too many times, we will not retry again.'
        ),
      ]),
      findPath
    )
    expect(event).toMatchObject({
      ratingKey: '77957',
      plexPath: null,
      via: 'line',
      component: 'CreditsDetectionManager',
    })
  })

  it("takes the item from the thread's announcing line", () => {
    const events = extractEvents(
      logFile([
        at(1, '9', 'DEBUG', 'Butler: Scheduling credits marker creation for: 79140'),
        at(
          2,
          '8',
          'ERROR',
          '[CreditsDetectionManager] Detection is unsupported with multi-part media items'
        ),
        at(
          3,
          '9',
          'ERROR',
          '[CreditsDetectionManager] Detection is unsupported with multi-part media items'
        ),
      ]),
      findPath
    )
    // Thread 8 never announced anything; thread 9 did.
    expect(events.map(e => [e.ratingKey, e.via])).toEqual([
      [null, null],
      ['79140', 'context'],
    ])
  })

  it('pairs the announced item with the file a scanner then opens', () => {
    const file = '/media/Movies/Other HD/Friday After Next (2002)/Friday After Next (2002).mp4'
    const [event] = extractEvents(
      logFile(
        [
          at(1, '7', 'DEBUG', 'Analyzing media parts for item 65101 (Friday After Next): 127290'),
          at(1, '7', 'DEBUG', `[ID 127291] Media part analysis: ${file}`),
          at(2, '7', 'WARN', '[FFMPEG] - stream 0, timescale not set'),
        ],
        'Plex Media Scanner Analysis'
      ),
      findPath
    )
    expect(event).toMatchObject({
      ratingKey: '65101',
      plexPath: file,
      via: 'context',
      family: 'Plex Media Scanner Analysis',
    })
  })

  it('does not take context from lines that merely mention a path', () => {
    const [event] = extractEvents(
      logFile([
        at(
          1,
          '5',
          'DEBUG',
          'Updating part with ID=18831 [/media/Movies/HD/Heat (1995)/Heat (1995).mkv]'
        ),
        at(2, '5', 'WARN', 'NAT: PMP, got an error: Not Supported by gateway.'),
      ]),
      findPath
    )
    expect(event!.via).toBeNull()
  })

  it('never gives context to request-handler errors', () => {
    const [event] = extractEvents(
      logFile([
        at(1, '5', 'DEBUG', '[CreditsDetectionManager] Running credits detection for item 1'),
        at(2, '5', 'ERROR', '[Req#1f0a2] Unknown metadata type: folder'),
      ]),
      findPath
    )
    expect(event!.via).toBeNull()
  })

  it('lets context expire', () => {
    const [event] = extractEvents(
      logFile([
        'Sep 14, 2026 04:00:00.000 [5] DEBUG - [CreditsDetectionManager] Running credits detection for item 1',
        'Sep 14, 2026 04:30:00.000 [5] ERROR - [CreditsDetectionManager] incomplete marker attributes',
      ]),
      findPath
    )
    expect(event!.ratingKey).toBeNull()
  })
})
