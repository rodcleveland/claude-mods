import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  collectionName,
  diff,
  lastExchange,
  lineDiff,
  memsearchEntry,
  parseOps,
  sinkText,
  stagingEntry,
  stagingPath,
  totals,
} from '../hooks/register'

test('diff names added, updated and deleted memories with their line counts', async () => {
  const before = new Map([['a.md', 'one\ntwo\n'], ['b.md', 'one\ntwo\nthree\n'], ['c.md', 'gone\nalso gone\n']])
  const after = new Map([['a.md', 'one\ntwo\n'], ['b.md', 'one\n2\nthree\nfour\n'], ['d.md', 'new\n']])

  expect(diff(before, after)).toEqual([
    { name: 'b.md', kind: 'updated', added: 2, removed: 1 },
    { name: 'd.md', kind: 'added', added: 1, removed: 0 },
    { name: 'c.md', kind: 'deleted', added: 0, removed: 2 },
  ])
  expect(totals(diff(before, after))).toEqual({ added: 3, removed: 3 })
})

test('lineDiff counts a moved line as one removed and one added', async () => {
  expect(lineDiff('a\nb\nc', 'b\nc\na')).toEqual({ added: 1, removed: 1 })
  expect(lineDiff('', '')).toEqual({ added: 0, removed: 0 })
  expect(lineDiff('same\n', 'same')).toEqual({ added: 0, removed: 0 })
})

test('lastExchange starts at the latest typed prompt', async () => {
  const text = lastExchange([
    { role: 'user', text: 'old prompt', toolUses: [] },
    { role: 'assistant', text: 'old answer', toolUses: [] },
    { role: 'user', text: 'remember I prefer bun', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'x', isError: false } as never] },
    { role: 'assistant', text: 'Noted.', toolUses: [] },
  ])

  expect(text).toBe('USER: remember I prefer bun\nTOOL: Read\nASSISTANT: Noted.')
})

test('the main session may not write the memory folder', async ($, on) => {
  mock.env(on, { HOME: '/home/r' })
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('tool.call', () => ({ result: 'written' }) as never)

  const blocked = await $.tool.call({ tool: 'Write', file_path: '/home/r/.claude/projects/-w-proj/memory/x.md', content: 'x' })
  const allowed = await $.tool.call({ tool: 'Write', file_path: '/w/proj/x.md', content: 'x' })

  expect(blocked.deny ?? blocked.text).toContain('memory-fork')
  expect(allowed.deny).toBeUndefined()
})

test('parseOps keeps bare memory names and never deletes the index', async () => {
  const ops = parseOps(`Here: {"write": [{"name": "a.md", "content": "x"}, {"name": "../evil.md", "content": "x"}, {"name": "b.txt", "content": "x"}], "delete": ["MEMORY.md", "c.md", "/etc/d.md"]}`)

  expect(ops).toEqual({ write: [{ name: 'a.md', content: 'x' }], delete: ['c.md'], note: '' })
})

test('parseOps keeps the log note, trimmed, and ignores a note that is not text', async () => {
  expect(parseOps('{"write": [], "delete": [], "note": "  Chose bun over npm.  "}').note).toBe('Chose bun over npm.')
  expect(parseOps('{"write": [], "delete": [], "note": 3}').note).toBe('')
})

test('the vault staging file sits under the config folder, one per project', async () => {
  expect(stagingPath('/home/r/.claude', '/home/r/wslrepos/claude-mods')).toBe(
    '/home/r/.claude/memory-fork/staging/-home-r-wslrepos-claude-mods.md',
  )
})

test('a staged entry carries the time, the session and the memory files', async () => {
  const at = new Date(2026, 9, 13, 9, 5)
  expect(stagingEntry(at, 's1', 'Chose bun over npm.', ['bun.md', 'MEMORY.md'])).toBe(
    '\n## 2026-10-13 09:05\n<!-- session:s1 -->\n- Chose bun over npm.\n- Memory files: bun.md, MEMORY.md\n',
  )
  expect(stagingEntry(at, 's1', 'Nothing filed.', [])).not.toContain('Memory files')
})

test('a memsearch entry matches memsearch\'s own turn format', async () => {
  expect(memsearchEntry(new Date(2026, 9, 13, 21, 44), 's1', 'Chose bun.')).toBe(
    '### 21:44\n<!-- session:s1 source:memory-fork -->\n- Chose bun.\n\n',
  )
})

test('the memsearch collection is named as derive-collection.sh names it', async () => {
  // printf '%s' /home/rodman/kdp | sha256sum | cut -c1-8
  expect(await collectionName('/home/rodman/kdp')).toBe(`ms_kdp_14e04234`)
  expect(await collectionName('/w/My Project!')).toMatch(/^ms_my_project_[0-9a-f]{8}$/)
})

test('the band names the stores that were tried', async () => {
  expect(sinkText({ vault: 'written', memsearch: 'off' })).toBe('· vault staged')
  expect(sinkText({ vault: 'written', memsearch: 'written' })).toBe('· vault staged · memsearch')
  expect(sinkText({ vault: 'failed', memsearch: 'unindexed' })).toBe('· vault staging failed · memsearch (not indexed)')
})

// The engine beneath the plugin: a memory folder in a map, a judge that says UPDATE, and a fork
// that answers with one memory file and a log note. `hasMemsearch` says whether the command exists.
function engine(on: On, hasMemsearch: boolean) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/r' })
  const files = new Map<string, string>([['/home/r/.claude/projects/-w-proj/memory/MEMORY.md', '# Memory\n']])
  const ran: string[][] = []
  on('session.cwd', () => ({ value: '/w/proj/sub' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', text: 'remember I prefer bun', toolUses: [] }] }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'UPDATE: prefers bun', usage: {} } }) as never)
  on('model.fork', () =>
    ({
      value: {
        isAnswered: true,
        text: '{"write": [{"name": "bun.md", "content": "Prefers bun.\\n"}, {"name": "MEMORY.md", "content": "# Memory\\n- bun\\n"}], "delete": [], "note": "Rod prefers bun over npm."}',
      },
    }) as never,
  )
  on('fs.list', ($, e) =>
    ({
      value: [...files.keys()]
        .filter(path => path.startsWith(`${(e as { path: string }).path}/`))
        .map(path => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
    }) as never,
  )
  on('fs.read', ($, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, text)
    return { value: undefined } as never
  })
  on('process.run', ($, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    ran.push(argv)
    if (argv[0] === 'sh') return { value: { exitCode: hasMemsearch ? 0 : 1, stdout: '', stderr: '' } } as never
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: '/w/proj\n', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('turn.complete', ($, e) => ({ text: (e as { answer?: string }).answer ?? '' }) as never)
  return { clock, files, ran }
}

const STAGED = '/home/r/.claude/memory-fork/staging/-w-proj-sub.md'

test('a turn worth remembering writes the memory, stages the vault note and writes memsearch', async ($, on) => {
  const { clock, files, ran } = engine(on, true)
  await $.turn.complete({ reason: 'answer', answer: 'Noted.' } as never)
  await clock.settle()

  expect(files.get('/home/r/.claude/projects/-w-proj-sub/memory/bun.md')).toBe('Prefers bun.\n')
  expect(files.get(STAGED)).toContain('# memory-fork notes for the vault')
  expect(files.get(STAGED)).toContain('- Rod prefers bun over npm.')
  expect(files.get(STAGED)).toContain('- Memory files: bun.md, MEMORY.md')
  const daily = [...files.keys()].find(path => path.startsWith('/w/proj/.memsearch/memory/'))
  expect(daily && files.get(daily)).toContain('<!-- session:s1 source:memory-fork -->\n- Rod prefers bun over npm.')
  expect(ran.find(argv => argv[0] === 'memsearch')?.slice(0, 4)).toEqual(['memsearch', 'index', '/w/proj/.memsearch/memory', '--collection'])
})

test('without memsearch installed only the vault note is staged', async ($, on) => {
  const { clock, files, ran } = engine(on, false)
  await $.turn.complete({ reason: 'answer', answer: 'Noted.' } as never)
  await clock.settle()

  expect(files.get(STAGED)).toContain('- Rod prefers bun over npm.')
  expect([...files.keys()].some(path => path.includes('.memsearch'))).toBe(false)
  expect(ran.some(argv => argv[0] === 'memsearch')).toBe(false)
})
