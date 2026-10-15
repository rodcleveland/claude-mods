import { expect, mock, test } from 'claude-code/testing'

const QUESTIONS = [
  { text: 'Does food need a name?' },
  { text: 'Should the hidden items be copied too?', section: 'The copies' },
  { text: 'Who updates stock and prices?', section: 'The copies' },
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`answers typed in the pane come back as one message (${surface})`, async ($, on) => {
    const sent: string[] = []
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.close', () => ({ value: undefined }) as never)
    on('ui.focus', () => ({}) as never)
    on('prompt.submit', ($, e) => {
      sent.push(e.text)
      return { text: e.text } as never
    })

    const ran = await $.tool.call({
      tool: 'mcp__question-pane__ask_questions',
      title: 'Clover items',
      questions: QUESTIONS,
    } as never)
    expect(ran.deny).toBeUndefined()

    const pane = await $.ui.mount({
      plugin: 'question-pane',
      surface,
      component: 'Pane',
      requestId: 'questions',
      props: {
        title: 'Questions for you',
        isFocused: true,
        bodyColumns: 90,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await pane.find({ key: 'answer:0' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'The copies' })).toBeDefined()

    await pane.input({ key: 'answer:0', text: 'Drinks are enough', kind: 'change' })
    await pane.input({ key: 'answer:2', text: 'Automate it', kind: 'change' })
    await pane.press({ key: 'submit' })

    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('1. Does food need a name?\n   Answer: Drinks are enough')
    expect(sent[0]).toContain('## The copies')
    expect(sent[0]).toContain('2. Should the hidden items be copied too?\n   Answer: (no answer)')
    expect(sent[0]).toContain('3. Who updates stock and prices?\n   Answer: Automate it')
  })
}

test('a call with no questions is refused', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__question-pane__ask_questions', questions: [] } as never)
  expect(ran.deny).toContain('needs questions')
})

test('turned off, the tool answers "ask in chat" and opens no pane', async ($, on) => {
  mock.store(on)
  let opened = 0
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } } as never
  })
  const flipped = await $.command.run({ command: 'question-pane', args: 'off' } as never)
  expect(flipped.text).toContain('off')
  const ran = await $.tool.call({ tool: 'mcp__question-pane__ask_questions', questions: QUESTIONS } as never)
  expect(String(ran.result)).toContain('turned off')
  expect(opened).toBe(0)

  await $.command.run({ command: 'question-pane', args: 'on' } as never)
  const again = await $.tool.call({ tool: 'mcp__question-pane__ask_questions', questions: QUESTIONS } as never)
  expect(String(again.result)).toContain('questions is open')
  expect(opened).toBe(1)
})
