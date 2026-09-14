import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import jsYaml from 'js-yaml'

import { LEVEL_KEYS, parseIgnoreList } from '../../../src/core/ignored'
import type { IgnoreMediaType } from '../../../src/core/ignored'

/**
 * The committed `ignored/<type>.yaml.example` templates are what people copy.
 * Uncommenting every example in one must produce a valid ignore list that uses
 * every level key — so the templates can't drift into syntax the loader
 * rejects (as the old `types:` scoping advice once did).
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const TYPES: IgnoreMediaType[] = ['movies', 'shows', 'music', 'audiobooks']

/** Turn `# key:` and `#   - item` lines back into YAML; drop every other comment. */
function uncomment(template: string): string {
  return template
    .split(/\r?\n/)
    .filter(line => /^# [a-z]+:$/.test(line) || /^# {3}- /.test(line))
    .map(line => line.slice(2))
    .join('\n')
}

describe('ignored/<type>.yaml.example templates', () => {
  it.each(TYPES)('%s: every uncommented example is a valid entry', mediaType => {
    const file = path.join(REPO_ROOT, 'ignored', `${mediaType}.yaml.example`)
    const raw = jsYaml.load(uncomment(fs.readFileSync(file, 'utf-8')))

    const list = parseIgnoreList(raw, mediaType, `${mediaType}.yaml.example`)
    expect(list.entries.length).toBeGreaterThan(0)

    // Every level the type supports is demonstrated.
    expect(Object.keys(raw as object).sort()).toEqual([...LEVEL_KEYS[mediaType]].sort())
  })
})
