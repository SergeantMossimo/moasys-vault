# MOASYS-Vault — Output schemas

JSON Schema (Draft 2020-12) definitions for everything the scanner writes under `output/<drive>/<type>/` and the Plex commands write under `output/plex/`. Useful when you're building a downstream consumer (e.g. the personal website) and want IDE autocomplete or runtime validation.

## Files

| Schema                                                   | Describes                                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [common.json](common.json)                               | Shared `Version` definition referenced by all four catalog schemas.                                                                                                                     |
| [movies.json](movies.json)                               | `output/<drive>/movies/movies.json` — your movies catalog.                                                                                                                              |
| [shows.json](shows.json)                                 | `output/<drive>/shows/shows.json` — your shows catalog with seasons + episodes.                                                                                                         |
| [music.json](music.json)                                 | `output/<drive>/music/music.json` — your music catalog (artists → albums).                                                                                                              |
| [audiobooks.json](audiobooks.json)                       | `output/<drive>/audiobooks/audiobooks.json` — your audiobooks catalog.                                                                                                                  |
| [warnings.json](warnings.json)                           | `output/<drive>/<type>/warnings.json`, and `validation-warnings.json`, `plex-warnings.json`, `plex-log-warnings.json` beside it (plus their `unfiltered/` copies) — all the same shape. |
| [validation-movies.json](validation-movies.json)         | `output/<drive>/movies/data/validation.json` — TMDB cross-check results for movies.                                                                                                     |
| [validation-shows.json](validation-shows.json)           | `output/<drive>/shows/data/validation.json` — TMDB cross-check results for shows.                                                                                                       |
| [validation-audiobooks.json](validation-audiobooks.json) | `output/<drive>/audiobooks/data/validation.json` — Open Library cross-check results for audiobooks.                                                                                     |
| [plex-common.json](plex-common.json)                     | Shared `Library` and `MediaType` definitions referenced by the Plex schemas.                                                                                                            |
| [plex-libraries.json](plex-libraries.json)               | `output/plex/libraries.json` — index of every Plex library and how it maps to your roots.                                                                                               |
| [plex-catalog.json](plex-catalog.json)                   | `output/plex/<library>/catalog.json` — every item in one Plex library, with mapped file paths.                                                                                          |
| [plex-collections.json](plex-collections.json)           | `output/plex/<library>/collections.json` — collections in one Plex library and their items.                                                                                             |
| [plex-logs-summary.json](plex-logs-summary.json)         | `output/plex/logs-summary.json` — every distinct problem in the Plex server's logs, with counts.                                                                                        |

## Using these

Plug them into [ajv](https://ajv.js.org/), [zod](https://zod.dev/) (via [json-schema-to-zod](https://github.com/StefanTerdell/json-schema-to-zod)), or whatever validator your stack prefers:

```ts
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import warningsSchema from './schemas/warnings.json'

const ajv = new Ajv()
addFormats(ajv)
const validate = ajv.compile(warningsSchema)
if (!validate(yourWarningsJson)) console.error(validate.errors)
```

IDEs (VS Code, JetBrains) can use these directly via the `$schema` reference at the top of each generated file — or you can map files explicitly in your editor settings.

## Drift

These schemas are hand-maintained alongside the TypeScript types in [src/core/types.ts](../src/core/types.ts), [src/validate/types.ts](../src/validate/types.ts), [src/plex/types.ts](../src/plex/types.ts), and [src/plex/log-checks.ts](../src/plex/log-checks.ts) (`PlexLogSummaryOutput`). If you change a catalog shape, update the matching schema here in the same PR. The tradeoff vs. generating schemas from Zod: simpler dependencies and zero build step, at the cost of needing one extra file touch per shape change. Shape changes are rare.
