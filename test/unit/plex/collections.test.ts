import { describe, it, expect, vi } from 'vitest'

import {
  parseArgs,
  toLibraryItem,
  undoOperations,
  CollectionJournal,
} from '../../../src/plex/collections'
import { parseItemText, parseReview, removeLines } from '../../../src/plex/collections-format'
import {
  LibraryItem,
  LiveCollection,
  planChanges,
  resolveLine,
} from '../../../src/plex/collections-plan'
import {
  CollectionWrite,
  PlexCollectionsWriter,
  WriteScope,
  assertCollectionWrite,
  metadataUri,
} from '../../../src/plex/collections-writer'

const MACHINE = 'abc123'
const item = (
  ratingKey: string,
  title: string,
  year: number | null,
  extra: Partial<LibraryItem> = {}
): LibraryItem => ({
  ratingKey,
  title,
  year,
  artist: null,
  tmdbId: null,
  tmdbTitle: null,
  ...extra,
})
const coll = (
  ratingKey: string,
  title: string,
  itemKeys: string[] = [],
  smart = false
): LiveCollection => ({
  ratingKey,
  title,
  smart,
  itemKeys: new Set(itemKeys),
})

describe('parseReview', () => {
  const text = [
    '# Movies: collections',
    '',
    '# Create',
    '## Toy Story',
    '- Toy Story (1995)',
    '- Toy Story 2 (1999)',
    '',
    '# add',
    '## Pixar',
    '- Hoppers (2026)',
    'Some prose that is ignored.',
    '',
    '#Remove',
    '## Pixar',
    '- Feast (2014)',
  ].join('\n')

  it('reads sections case-insensitively, including "#Remove" without a space', () => {
    const { blocks, stray } = parseReview(text)
    expect(stray).toEqual([])
    expect(blocks.map(b => [b.action, b.name, b.items.map(i => i.title)])).toEqual([
      ['create', 'Toy Story', ['Toy Story', 'Toy Story 2']],
      ['add', 'Pixar', ['Hoppers']],
      ['remove', 'Pixar', ['Feast']],
    ])
  })

  it('ignores items under the title or an unknown section', () => {
    const { blocks, stray } = parseReview('# Notes\n## Thing\n- Not an action (2000)\n')
    expect(blocks).toEqual([])
    expect(stray).toEqual([])
  })

  it('flags an item under an action section but no collection heading', () => {
    expect(parseReview('# Add\n- Orphan (2001)\n').stray.map(s => s.text)).toEqual([
      'Orphan (2001)',
    ])
  })

  it('splits album lines into album, artist and year', () => {
    expect(parseItemText('Incredibad — The Lonely Island (2009)')).toMatchObject({
      title: 'Incredibad',
      artist: 'The Lonely Island',
      year: 2009,
    })
    expect(parseItemText('Spider-Man: Far From Home')).toMatchObject({
      title: 'Spider-Man: Far From Home',
      artist: null,
      year: null,
    })
  })
})

describe('removeLines', () => {
  it('drops finished lines, then empty collections and empty sections', () => {
    const text =
      '# Movies\n\n# Create\n## A\n- One (2000)\n\n# Add\n## B\n- Two (2001)\n- Three (2002)\n'
    const lines = text.split('\n')
    const drop = new Set([lines.indexOf('- One (2000)'), lines.indexOf('- Two (2001)')])
    expect(removeLines(text, drop)).toBe('# Movies\n\n# Add\n## B\n- Three (2002)\n')
  })
})

describe('resolveLine', () => {
  const items = [
    item('1', 'New Nightmare', 1994, { tmdbId: '11596', tmdbTitle: "Wes Craven's New Nightmare" }),
    item('2', 'Frasier (2023)', 2023),
    item('3', 'Frasier', 1993),
    item('4', "Grandma's Boy", 2006, { tmdbId: '9900' }),
    item('5', "Grandma's Boy", 2006, { tmdbId: '9900' }),
    item('6', 'Hamlet', 1948, { tmdbId: '10' }),
    item('7', 'Hamlet', 1990, { tmdbId: '11' }),
    item('8', 'Incredibad', 2009, { artist: 'The Lonely Island' }),
  ]
  const r = (text: string) => resolveLine(parseItemText(text), items).map(i => i.ratingKey)

  it('matches on the TMDB title when Plex spells it differently', () => {
    expect(r("Wes Craven's New Nightmare (1994)")).toEqual(['1'])
  })
  it('matches a Plex title that carries its own year', () => {
    expect(r('Frasier (2023)')).toEqual(['2'])
    expect(r('Frasier (1993)')).toEqual(['3'])
  })
  it('returns every copy of one title', () => {
    expect(r("Grandma's Boy (2006)")).toEqual(['4', '5'])
  })
  it('allows a year one off', () => {
    expect(r('Hamlet (1949)')).toEqual(['6'])
  })
  it('refuses a line that names two different titles', () => {
    expect(() => r('Hamlet')).toThrow(/more than one title/)
  })
  it('refuses a line that names nothing', () => {
    expect(() => r('Not a Movie (2000)')).toThrow(/no match/)
  })
  it('checks the artist on album lines', () => {
    expect(r('Incredibad — The Lonely Island (2009)')).toEqual(['8'])
    expect(() => r('Incredibad — Someone Else')).toThrow(/no match/)
  })
})

describe('planChanges', () => {
  const items = [
    item('1', 'Toy Story', 1995),
    item('2', 'Hoppers', 2026),
    item('3', 'Feast', 2014),
    item('4', 'Up', 2009),
  ]
  const live = [
    coll('100', 'Pixar', ['3', '4']),
    coll('200', 'The X Files'),
    coll('300', 'Smarty', [], true),
  ]
  const plan = (md: string) => planChanges(parseReview(md), items, live)

  it('plans a create, adds only what is missing, removes only what is there', () => {
    const p = plan(
      '# Create\n## Toy Story\n- Toy Story (1995)\n# Add\n## Pixar\n- Hoppers (2026)\n- Up (2009)\n# Remove\n## Pixar\n- Feast (2014)\n- Toy Story (1995)\n'
    )
    expect(p.problems).toEqual([])
    expect(p.operations.map(o => [o.kind, o.collection, o.collectionKey, o.ratingKeys])).toEqual([
      ['create', 'Toy Story', '', ['1']],
      ['add', 'Pixar', '100', ['2']],
      ['remove', 'Pixar', '100', ['3']],
    ])
    expect(p.skipped.map(s => [s.line.title, s.reason])).toEqual([
      ['Up', 'already in it'],
      ['Toy Story', 'not in it'],
    ])
  })

  it('refuses to create a collection that exists', () => {
    expect(plan('# Create\n## Pixar\n- Toy Story (1995)\n').problems[0]).toMatch(/already exists/)
  })

  it('refuses to create a near-duplicate name', () => {
    expect(plan('# Create\n## The X-Files\n- Up (2009)\n').problems[0]).toMatch(
      /almost the same as the existing "The X Files"/
    )
  })

  it('refuses to add to or remove from a collection that does not exist', () => {
    expect(plan('# Add\n## Dreamworks\n- Up (2009)\n').problems[0]).toMatch(/doesn't exist/)
    expect(plan('# Remove\n## X Files\n- Up (2009)\n').problems[0]).toMatch(
      /did you mean "The X Files"/
    )
  })

  it('refuses smart collections', () => {
    expect(plan('# Add\n## Smarty\n- Up (2009)\n').problems[0]).toMatch(/smart collection/)
  })

  it('plans nothing when any line fails, and reports every problem', () => {
    const p = plan('# Add\n## Pixar\n- Hoppers (2026)\n- Nope (1900)\n- Also Nope (1901)\n')
    expect(p.operations).toEqual([])
    expect(p.problems).toHaveLength(2)
  })

  it('refuses the same title under Add and Remove for one collection', () => {
    expect(
      plan('# Add\n## Pixar\n- Hoppers (2026)\n# Remove\n## Pixar\n- Hoppers (2026)\n').problems[0]
    ).toMatch(/both # Add and # Remove/)
  })
})

describe('assertCollectionWrite', () => {
  const scope = (): WriteScope => ({
    machineId: MACHINE,
    sectionKey: '1',
    typeNumber: 1,
    itemKeys: new Set(['10', '11']),
    collectionKeys: new Set(['500']),
  })
  const ok = (req: CollectionWrite) => () => assertCollectionWrite(req, scope())
  const create = (params: Record<string, string> = {}): CollectionWrite => ({
    method: 'POST',
    path: '/library/collections',
    params: {
      type: '1',
      title: 'New',
      smart: '0',
      sectionId: '1',
      uri: metadataUri(MACHINE, ['10', '11']),
      ...params,
    },
  })

  it('allows the three collection changes', () => {
    expect(ok(create())).not.toThrow()
    expect(
      ok({
        method: 'PUT',
        path: '/library/collections/500/items',
        params: { uri: metadataUri(MACHINE, ['10']) },
      })
    ).not.toThrow()
    expect(
      ok({ method: 'DELETE', path: '/library/collections/500/items/11', params: {} })
    ).not.toThrow()
  })

  it.each([
    ['refreshing a library', 'PUT', '/library/sections/1/refresh', {}],
    ['editing metadata', 'PUT', '/library/metadata/10', { 'title.value': 'x' }],
    ['deleting an item', 'DELETE', '/library/metadata/10', {}],
    ['deleting a collection', 'DELETE', '/library/collections/500', {}],
    ['emptying the trash', 'PUT', '/library/sections/1/emptyTrash', {}],
    ['a GET', 'GET', '/library/collections', {}],
    ['a PATCH', 'PATCH', '/library/collections/500/items', { uri: metadataUri(MACHINE, ['10']) }],
    [
      'POST to another path',
      'POST',
      '/library/collections/500/items',
      { uri: metadataUri(MACHINE, ['10']) },
    ],
    ['a path with a traversal', 'PUT', '/library/collections/500/items/../../metadata/10', {}],
  ])('refuses %s', (_, method, p, params) => {
    expect(ok({ method: method as CollectionWrite['method'], path: p, params })).toThrow(
      /Refused Plex write/
    )
  })

  it('refuses extra or missing parameters', () => {
    expect(ok(create({ summary: 'x' }))).toThrow(/parameters must be exactly/)
    expect(
      ok({ method: 'DELETE', path: '/library/collections/500/items/11', params: { force: '1' } })
    ).toThrow(/parameters/)
  })

  it('refuses smart collections, another library, and a mismatched type', () => {
    expect(ok(create({ smart: '1' }))).toThrow(/non-smart/)
    expect(ok(create({ sectionId: '2' }))).toThrow(/selected library/)
    expect(ok(create({ type: '2' }))).toThrow(/type must match/)
    expect(ok(create({ type: '4' }))).toThrow(/type must match/)
  })

  it('refuses another server, non-numeric ids and items outside the library', () => {
    expect(ok(create({ uri: metadataUri('other-server', ['10']) }))).toThrow(/this server/)
    expect(ok(create({ uri: metadataUri(MACHINE, ['10', 'x']) }))).toThrow(/numeric/)
    expect(ok(create({ uri: metadataUri(MACHINE, ['10', '99']) }))).toThrow(/item 99/)
    expect(ok({ method: 'DELETE', path: '/library/collections/500/items/99', params: {} })).toThrow(
      /item 99/
    )
  })

  it('refuses a collection outside the library', () => {
    expect(
      ok({
        method: 'PUT',
        path: '/library/collections/777/items',
        params: { uri: metadataUri(MACHINE, ['10']) },
      })
    ).toThrow(/collection 777/)
  })
})

describe('PlexCollectionsWriter', () => {
  const scope = (): WriteScope => ({
    machineId: MACHINE,
    sectionKey: '1',
    typeNumber: 1,
    itemKeys: new Set(['10', '11']),
    collectionKeys: new Set(['500']),
  })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('sends the method, URL and token header, and registers a created collection', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ MediaContainer: { Metadata: [{ ratingKey: '600' }] } })
    )
    const s = scope()
    const writer = new PlexCollectionsWriter(
      'http://nas:32400/',
      'tok',
      s,
      fetchImpl as unknown as typeof fetch,
      0
    )

    expect(await writer.create('Toy Story', ['10'])).toBe('600')
    await writer.add('600', ['11'])
    await writer.remove('500', '10')

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([u, init]) => [init.method, new URL(u).pathname])).toEqual([
      ['POST', '/library/collections'],
      ['PUT', '/library/collections/600/items'],
      ['DELETE', '/library/collections/500/items/10'],
    ])
    const created = new URL(calls[0]![0])
    expect(created.searchParams.get('uri')).toBe(
      `server://${MACHINE}/com.plexapp.plugins.library/library/metadata/10`
    )
    expect(calls[0]![0]).not.toContain('tok')
    expect((calls[0]![1].headers as Record<string, string>)['X-Plex-Token']).toBe('tok')
    expect(s.collectionKeys.has('600')).toBe(true)
  })

  it('never sends a refused request', async () => {
    const fetchImpl = vi.fn()
    const writer = new PlexCollectionsWriter(
      'http://nas:32400',
      'tok',
      scope(),
      fetchImpl as unknown as typeof fetch,
      0
    )
    await expect(writer.add('999', ['10'])).rejects.toThrow(/collection 999/)
    await expect(writer.remove('500', '42')).rejects.toThrow(/item 42/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports an HTTP error without the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500, statusText: 'tok broke' }))
    const writer = new PlexCollectionsWriter(
      'http://nas:32400',
      'tok',
      scope(),
      fetchImpl as unknown as typeof fetch,
      0
    )
    const err = (await writer.add('500', ['10']).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/HTTP 500/)
    expect(err.message).not.toContain('tok broke')
  })
})

describe('undoOperations', () => {
  const journal = (ops: CollectionJournal['operations']): CollectionJournal => ({
    generated: '',
    mode: 'apply',
    library: { key: '1', title: 'Movies', slug: 'movies' },
    server: MACHINE,
    source: 'x',
    operations: ops,
  })

  it('removes what was created or added, re-adds what was removed, and skips what never ran', () => {
    const ops = undoOperations(
      journal([
        {
          kind: 'create',
          collection: 'Toy Story',
          collection_key: '600',
          rating_keys: ['10', '11'],
          items: [],
          status: 'done',
        },
        {
          kind: 'add',
          collection: 'Pixar',
          collection_key: '500',
          rating_keys: ['12'],
          items: [],
          status: 'done',
        },
        {
          kind: 'remove',
          collection: 'Pixar',
          collection_key: '500',
          rating_keys: ['13'],
          items: [],
          status: 'done',
        },
        {
          kind: 'add',
          collection: 'Pixar',
          collection_key: '500',
          rating_keys: ['14'],
          items: [],
          status: 'failed',
        },
        {
          kind: 'add',
          collection: 'Pixar',
          collection_key: '500',
          rating_keys: ['15'],
          items: [],
          status: 'planned',
        },
      ])
    )
    expect(ops.map(o => [o.kind, o.collectionKey, o.ratingKeys])).toEqual([
      ['remove', '600', ['10']],
      ['remove', '600', ['11']],
      ['remove', '500', ['12']],
      ['add', '500', ['13']],
    ])
  })
})

describe('collections CLI helpers', () => {
  it('takes exactly one library and known flags', () => {
    expect(parseArgs(['movies', '--apply'])).toMatchObject({ library: 'movies', apply: true })
    expect(parseArgs(['music', '--file', 'x.md'])).toMatchObject({ file: 'x.md' })
    expect(() => parseArgs([])).toThrow(/exactly one library/)
    expect(() => parseArgs(['movies', 'shows'])).toThrow(/exactly one library/)
    expect(() => parseArgs(['movies', '--aply'])).toThrow(/Unknown option/)
    expect(() => parseArgs(['movies', '--file'])).toThrow(/needs a path/)
  })

  it('reads the TMDB id and album artist off live metadata', () => {
    const titles = new Map([['578', 'Jaws']])
    expect(
      toLibraryItem(
        {
          ratingKey: '1',
          type: 'movie',
          title: 'Jaws',
          year: 1975,
          Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://578' }],
        },
        titles
      )
    ).toMatchObject({
      tmdbId: '578',
      tmdbTitle: 'Jaws',
      artist: null,
    })
    expect(
      toLibraryItem(
        { ratingKey: '2', type: 'album', title: 'Incredibad', parentTitle: 'The Lonely Island' },
        titles
      ).artist
    ).toBe('The Lonely Island')
  })
})
