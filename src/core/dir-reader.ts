/**
 * core/dir-reader.ts
 * ------------------
 * One directory listing per folder per run.
 *
 * Each scan walks the library twice — the probe pass to find files to
 * ffprobe, then the scan pass to parse names and build the catalog — and both
 * list exactly the same folders. On a network share a listing is a round trip,
 * so with a warm probe cache the second walk was most of a run's time. One
 * `DirReader` is created per type per run and handed to both passes, so the
 * scan pass reads what the probe pass already listed.
 *
 * A failed listing (permission denied, a folder removed mid-run) is
 * remembered too and rethrown on every read, so both passes see the same
 * library. Read-only: it only ever lists and stats.
 */

import fs from 'fs'

export class DirReader {
  private listings = new Map<string, fs.Dirent[] | Error>()
  private dirs = new Map<string, boolean>()

  /** `fs.readdirSync(dirPath, { withFileTypes: true })`, read from disk once. */
  readdir(dirPath: string): fs.Dirent[] {
    let listing = this.listings.get(dirPath)
    if (listing === undefined) {
      try {
        listing = fs.readdirSync(dirPath, { withFileTypes: true })
      } catch (err) {
        listing = err as Error
      }
      this.listings.set(dirPath, listing)
    }
    if (listing instanceof Error) throw listing
    return listing
  }

  /** Whether `dirPath` exists and is a folder, checked on disk once. */
  isDirectory(dirPath: string): boolean {
    let isDir = this.dirs.get(dirPath)
    if (isDir === undefined) {
      isDir = fs.statSync(dirPath, { throwIfNoEntry: false })?.isDirectory() ?? false
      this.dirs.set(dirPath, isDir)
    }
    return isDir
  }
}
