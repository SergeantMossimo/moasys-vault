/**
 * plex/setup.ts
 * -------------
 * Shared startup for the `plex:*` commands: validate that Plex is configured,
 * load the token, and connect. Everything that can go wrong before the first
 * real request fails here with setup instructions.
 */

import path from 'path'

import { loadConfig, PLEX_OUTPUT_SEGMENT } from '../core/config'
import { AppConfig } from '../core/types'
import { loadSecrets } from '../validate/secrets'

import { itemTypesFor } from './catalog'
import { PlexClient } from './client'
import { PathMapper, rootRefs } from './paths'
import { PlexIdentity, PlexSection } from './types'

export const SCRIPT_DIR = path.join(__dirname, '..', '..')
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
/** output/plex/ — library pulls, independent of any drive. */
export const PLEX_OUTPUT_DIR = path.join(OUTPUT_DIR, PLEX_OUTPUT_SEGMENT)

export interface PlexSession {
  config: AppConfig
  client: PlexClient
  identity: PlexIdentity
  sections: PlexSection[]
  mapper: PathMapper
}

/** Exit with instructions when config.json has no plex block. */
function requirePlexConfig(config: AppConfig): NonNullable<AppConfig['plex']> {
  if (config.plex) return config.plex
  console.error('\n  Error: Plex isn\'t configured — config.json has no "plex" block.')
  console.error('    Add your server address to config.json:')
  console.error('      "plex": { "url": "http://192.168.1.50:32400" }')
  console.error('    and your token to .secrets.json:')
  console.error('      "plex": { "token": "..." }')
  console.error('    Full setup: docs/PLEX.md')
  process.exit(1)
}

/**
 * Load config and token, connect, list libraries, and build the path mapper.
 * Prints the connection summary and any library folders that couldn't be
 * mapped to a configured root.
 */
export async function openPlexSession(): Promise<PlexSession> {
  const config = loadConfig(SCRIPT_DIR)
  const plex = requirePlexConfig(config)
  const { token } = loadSecrets(SCRIPT_DIR, 'plex')
  const client = new PlexClient(plex.url, token)

  let identity: PlexIdentity
  let sections: PlexSection[]
  try {
    identity = await client.identity()
    sections = await client.sections()
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}`)
    process.exit(1)
  }

  console.log(`    [PLEX] Connected to ${plex.url} — Plex Media Server ${identity.version}`)
  console.log(`    [PLEX] ${sections.length} libraries`)

  // Photo libraries are never pulled, so don't report their folders as unmapped.
  const mediaSections = sections.filter(s => itemTypesFor(s.type).length > 0)
  const mapper = new PathMapper(rootRefs(config), mediaSections, plex.path_map)
  for (const { library, path: p } of mapper.unmappedLocations) {
    console.log(
      `    [PLEX] Library '${library}' folder ${p} doesn't match any root in config.json — ` +
        `its files won't be compared. Add a plex.path_map entry if it should (see docs/PLEX.md).`
    )
  }
  for (const { library, path: p, roots } of mapper.ambiguousLocations) {
    console.log(
      `    [PLEX] Library '${library}' folder ${p} matches several roots (${roots.join('; ')}); ` +
        `using the first. Add a plex.path_map entry to choose explicitly.`
    )
  }

  return { config, client, identity, sections, mapper }
}
