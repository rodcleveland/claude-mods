import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { activeSpans, dayKey, dayStart, formatDuration, isPaused, newRecord, parseQuery, pause, resume, sessionTotals, shiftDay, unpause } from '../hooks/logic'

const MIN = 60_000
const ROOT = '/work/clover'

// A fake disk under the plugin's $.fs calls, so the test sees what the mod writes.
function fakeDisk(on: On) {
  const files = new Map<string, string>()
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }) as never)
  on('fs.list', ($, e) => {
    const dir = `${e.path}/`
    const names = [...files.keys()].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  return files
}

// What the engine would answer beneath the plugin for the events it raises.
function engine(on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
}

test('active time counts turns and short gaps, not a session left open', () => {
  const t0 = dayStart('2026-10-15') + 9 * 60 * MIN
  const rec = newRecord('s1', ROOT, t0)
  rec.segments[0]!.end = t0 + 5 * 60 * MIN // left open for five hours
  rec.turns.push(
    { start: t0 + 2 * MIN, ms: 3 * MIN, model: 'm', reason: 'answer', input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    { start: t0 + 10 * MIN, ms: 1 * MIN, model: 'm', reason: 'answer', input: 1, output: 2, cacheRead: 300, cacheWrite: 4 },
  )
  const spans = activeSpans(rec, 15 * MIN)
  expect(spans.reduce((s, [a, b]) => s + b - a, 0)).toBe(11 * MIN)
  const tot = sessionTotals(rec, 15 * MIN)
  expect(tot.clockMs).toBe(5 * 60 * MIN)
  expect(tot.claudeMs).toBe(4 * MIN)
  expect(tot.turns).toBe(2)
  expect(tot.output).toBe(22)
  expect(tot.cacheRead).toBe(300)
})

test('a session over midnight splits its clock between the two days', () => {
  const t0 = shiftDay('2026-10-15', 1) - 30 * MIN
  const rec = newRecord('s2', ROOT, t0)
  rec.segments[0]!.end = t0 + 90 * MIN
  const first = sessionTotals(rec, 15 * MIN, dayStart('2026-10-15'), shiftDay('2026-10-15', 1))
  const second = sessionTotals(rec, 15 * MIN, shiftDay('2026-10-15', 1), shiftDay('2026-10-15', 2))
  expect(first.clockMs).toBe(30 * MIN)
  expect(second.clockMs).toBe(60 * MIN)
})

test('report arguments', () => {
  const now = dayStart('2026-10-15') + 12 * 60 * MIN
  const week = parseQuery('week all-projects', now)
  expect('error' in week).toBe(false)
  if (!('error' in week)) {
    expect(week.allProjects).toBe(true)
    expect(dayKey(week.from)).toBe('2026-10-09')
  }
  const range = parseQuery('2026-10-01..2026-10-03 sessions', now)
  if (!('error' in range)) {
    expect(range.listSessions).toBe(true)
    expect(range.to - range.from).toBe(3 * 24 * 60 * MIN)
  }
  expect('error' in parseQuery('fortnight', now)).toBe(true)
  expect(formatDuration(3 * 60 * MIN + 5 * MIN)).toBe('3h 05m')
})

test('turns are recorded to the project and show up in the report', async ($, on) => {
  mock.store(on)
  engine(on)
  const files = fakeDisk(on)
  let clock = dayStart('2026-10-15') + 10 * 60 * MIN
  on('clock.now', () => ({ value: clock }) as never)
  on('clock.every', () => ({ value: { cancel() {} } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.id', () => ({ value: 'abc12345-session' }) as never)
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: ROOT }) as never)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  expect(files.get(`${ROOT}/.claude/token-time/.gitignore`)).toBe('*\n')

  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  clock += 2 * MIN
  await $.turn.complete({
    answer: 'done',
    durationMs: 2 * MIN,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 800, model: 'claude-opus-5-5' },
  } as never)
  await $.turn.complete({
    answer: '',
    durationMs: 1000,
    isAborted: false,
    turnId: 'a1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
  } as never)

  const saved = JSON.parse(files.get(`${ROOT}/.claude/token-time/sessions/abc12345-session.json`) ?? '{}')
  expect(saved.turns.length).toBe(1)
  expect(saved.turns[0].output).toBe(3400)
  expect(saved.agentTurns.length).toBe(1)

  clock += 5 * MIN
  const report = await $.command.run({ command: 'token-time-report', args: 'today sessions' } as never)
  const text = String(report.text)
  expect(text).toContain('Token and time report: Today, clover')
  expect(text).toContain('7m 00s') // on the clock
  expect(text).toContain('2m 00s') // Claude working
  expect(text).toContain('3.4k')
  expect(text).toContain('abc12345')

  const bare = await $.command.run({ command: 'token-time-report', args: '' } as never)
  expect(String(bare.text)).toContain('Today, clover')
  expect(String(bare.text)).not.toContain('By project')

  const all = await $.command.run({ command: 'token-time-report', args: 'all all-projects' } as never)
  expect(String(all.text)).toContain('By project')
  expect(String(all.text)).toContain('2026-10-15')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows this session and the running turn (${surface})`, async ($, on) => {
    mock.store(on)
  engine(on)
    fakeDisk(on)
    const clock = dayStart('2026-10-15') + 10 * 60 * MIN
    on('clock.now', () => ({ value: clock }) as never)
    on('clock.every', () => ({ value: { cancel() {} } }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('session.id', () => ({ value: 'pane-session' }) as never)
    on('session.repo', () => ({ value: null }) as never)
    on('session.root', () => ({ value: ROOT }) as never)

    await $.session.start({ cwd: ROOT, surface, isInteractive: true } as never)
    await $.turn.start({ text: 'go', turnId: 't1' } as never)

    const pane = await $.ui.mount({
      plugin: 'token-and-time-tracking',
      surface,
      component: 'Pane',
      requestId: 'token-time',
      props: { title: 'Tokens and time', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    // Today's tab by default: the project's title, the three tiles and the chart.
    const found = async (text: string | RegExp) => (await pane.find({ type: 'Text', text })) !== undefined
    expect({
      title: await found(/TODAY · CLOVER/),
      tile: await found('ACTIVE TIME'),
      running: await found(/working now/),
      chart: await found(/day streak/),
    }).toEqual({ title: true, tile: true, running: true, chart: true })

    await pane.press({ key: 'tab-session' })
    expect(await pane.find({ type: 'Text', text: 'THIS SESSION' })).toBeDefined()
    await pane.press({ key: 'tab-week' })
    await pane.press({ key: 'scope' })
    expect(await pane.find({ type: 'Text', text: /LAST 7 DAYS · ALL PROJECTS/ })).toBeDefined()
  })
}

// A 60 minute session with one 20 minute turn at the start.
function hourSession() {
  const t0 = dayStart('2026-10-15') + 9 * 60 * MIN
  const rec = newRecord('p1', ROOT, t0)
  rec.segments[0]!.end = t0 + 60 * MIN
  rec.turns.push({ start: t0, ms: 20 * MIN, model: 'm', reason: 'answer', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  return { t0, rec }
}

test('a pause leaves its time out of active and Claude working, not the clock', () => {
  const { t0, rec } = hourSession()
  const base = sessionTotals(rec, 15 * MIN)
  const paused = sessionTotals({ ...rec, pauses: [{ start: t0 + 5 * MIN, end: t0 + 15 * MIN }] }, 15 * MIN)
  expect(paused.clockMs).toBe(base.clockMs)
  expect(paused.activeMs).toBe(base.activeMs - 10 * MIN)
  expect(paused.claudeMs).toBe(base.claudeMs - 10 * MIN)
  expect(paused.pausedMs).toBe(10 * MIN)
  expect(paused.output).toBe(base.output)
  expect(base.pausedMs).toBe(0)
})

test('overlapping pauses and pauses outside the session do not double count', () => {
  const { t0, rec } = hourSession()
  const tot = sessionTotals(
    {
      ...rec,
      pauses: [
        { start: t0 + 5 * MIN, end: t0 + 15 * MIN },
        { start: t0 + 10 * MIN, end: t0 + 20 * MIN },
        { start: t0 + 90 * MIN, end: t0 + 100 * MIN },
      ],
    },
    15 * MIN,
  )
  expect(tot.pausedMs).toBe(15 * MIN)
})

test('an open pause counts to the end of the segment', () => {
  const { t0, rec } = hourSession()
  const open = { ...rec, pauses: [{ start: t0 + 50 * MIN, end: null }] }
  expect(isPaused(open)).toBe(true)
  expect(sessionTotals(open, 15 * MIN).pausedMs).toBe(10 * MIN)
})

test('pause and unpause, including their no-op cases', () => {
  const { t0, rec } = hourSession()
  expect(isPaused(rec)).toBe(false)
  expect(unpause(rec, t0 + 5 * MIN)).toBe(rec) // not paused: nothing changes
  const p = pause(rec, t0 + 10 * MIN)
  expect(isPaused(p)).toBe(true)
  expect(p.pauses).toEqual([{ start: t0 + 10 * MIN, end: null }])
  expect(pause(p, t0 + 20 * MIN)).toBe(p) // already paused
  const u = unpause(p, t0 + 30 * MIN)
  expect(isPaused(u)).toBe(false)
  expect(u.pauses).toEqual([{ start: t0 + 10 * MIN, end: t0 + 30 * MIN }])
  // A clock that went backwards closes the pause at its start, never before it.
  expect(unpause(p, t0 + 5 * MIN).pauses).toEqual([{ start: t0 + 10 * MIN, end: t0 + 10 * MIN }])
})

test('resuming a session closes an open pause at the old segment end', () => {
  const { t0, rec } = hourSession()
  const open = { ...rec, pauses: [{ start: t0 + 50 * MIN, end: null }] }
  const again = resume(open, t0 + 5 * 60 * MIN)
  expect(isPaused(again)).toBe(false)
  expect(again.pauses).toEqual([{ start: t0 + 50 * MIN, end: t0 + 60 * MIN }])
  expect(again.segments.length).toBe(2)
})

test('/token-time pause and resume are saved and answered', async ($, on) => {
  mock.store(on)
  engine(on)
  const files = fakeDisk(on)
  let clock = dayStart('2026-10-15') + 10 * 60 * MIN
  on('clock.now', () => ({ value: clock }) as never)
  on('clock.every', () => ({ value: { cancel() {} } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.id', () => ({ value: 'pause-session' }) as never)
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: ROOT }) as never)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const run = async (args: string) => String((await $.command.run({ command: 'token-time', args } as never)).text)
  const file = `${ROOT}/.claude/token-time/sessions/pause-session.json`

  expect(await run('resume')).toBe("The timer isn't paused.")
  expect(await run('pause')).toBe('Timer paused.')
  expect(await run('pause')).toBe('The timer is already paused.')
  clock += 10 * MIN
  expect(await run('resume')).toBe('Timer resumed.')
  expect(await run('bogus')).toBe('Usage: /token-time [pause | resume]')

  const saved = JSON.parse(files.get(file) ?? '{}')
  expect(saved.pauses.length).toBe(1)
  expect(saved.pauses[0].end - saved.pauses[0].start).toBe(10 * MIN)

  // The report gets a Paused column.
  clock += 5 * MIN
  const report = String((await $.command.run({ command: 'token-time-report', args: 'today' } as never)).text)
  expect(report).toContain('Paused')
  expect(report).toContain('Paused: time you paused the timer, left out of Active and Claude working.')
})

test('the pane pauses and resumes from its button', async ($, on) => {
  mock.store(on)
  engine(on)
  fakeDisk(on)
  const clock = dayStart('2026-10-15') + 10 * 60 * MIN
  on('clock.now', () => ({ value: clock }) as never)
  on('clock.every', () => ({ value: { cancel() {} } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.id', () => ({ value: 'pane-pause' }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.root', () => ({ value: ROOT }) as never)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount({
    plugin: 'token-and-time-tracking',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-time',
    props: { title: 'Tokens and time', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const found = async (text: string | RegExp) => (await pane.find({ type: 'Text', text })) !== undefined
  const seen = { before: await found(/⏸ Pause/) }
  await pane.press({ key: 'pause' })
  const during = { resume: await found(/▶ Resume/), caption: await found(/paused/) }
  await pane.press({ key: 'pause' })
  expect({ ...seen, ...during, after: await found(/⏸ Pause/) }).toEqual({ before: true, resume: true, caption: true, after: true })
})
