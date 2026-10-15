import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import { answeredCount, formatAnswers, newForm, readQuestions, setAnswer } from './form-logic'

const PANE = 'questions'
const TOOL = 'ask_questions'
const TOOL_ID = 'mcp__question-pane__ask_questions'
const form = atom({ plugin: 'question-pane', key: 'form' } as const, null)
// The on/off switch: kept across sessions in the store, mirrored in state for Rods Rack to read.
const enabled = atom({ plugin: 'question-pane', key: 'enabled' } as const, true)
const STORE_KEY = 'enabled'
const OFF_ANSWER = 'The question form is turned off. Ask your questions in chat as a numbered list instead.'
const OFF_DESCRIPTION = 'Turned off by the person. Do not call it: ask questions in chat as a numbered list.'

const TOOL_DESCRIPTION = [
  'Show the person a form of questions, each with its own answer box, and a Submit button.',
  'Use it instead of a numbered list in chat whenever you have 3 or more open questions for the person.',
  'Pass the questions in order; give each an optional section heading to group them.',
  'The form opens in a pane. After calling this, end your turn: the answers arrive as the',
  "person's next message, each question followed by its answer.",
].join(' ')

async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  await $.store.set(STORE_KEY, isOn)
  // The tool's description says whether it is off; the new one goes out next turn.
  $.ui.invalidate('tool.describe')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY)
    // Written every start, so Rods Rack can tell this mod is installed.
    await update($, enabled, () => (typeof saved === 'boolean' ? saved : true))
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short heading for the form.' },
          questions: {
            type: 'array',
            description: 'The questions, in order.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The question, written in full.' },
                section: { type: 'string', description: 'Optional heading this question sits under.' },
              },
              required: ['text'],
            },
          },
        },
        required: ['questions'],
      },
    })
    await $.command.register({
      name: 'questions',
      description: 'Reopen the question form Claude last sent',
    })
    await $.command.register({
      name: 'question-pane',
      description: 'Turn the question form on or off: /question-pane on, off, or nothing to flip it',
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL_ID as never }, async ($, call) => {
    // Typed loosely: the tool's schema is only in the editor's types once the mod has loaded.
    const e = call as unknown as { questions?: unknown; title?: unknown }
    if (!(await read($, enabled))) return { result: OFF_ANSWER }
    const questions = readQuestions(e.questions)
    if (questions.length === 0) {
      return { deny: 'ask_questions needs questions: a list of { text, section? } objects.' }
    }
    await update($, form, () => newForm(e.title, questions))
    await $.ui.open({ id: PANE, title: 'Questions for you', focus: true, rows: 30, columns: 90 })
    return {
      result:
        `The form with ${questions.length} questions is open for the person. ` +
        "End your turn now; their answers will arrive as their next message.",
    }
  }).catch(() => ({ result: 'The question form could not open. Ask the questions in chat instead.' }))

  on('tool.describe', { tool: TOOL_ID as never }, async ($, e, next) => {
    const described = await next(e)
    if (await read($, enabled)) return described
    return { description: OFF_DESCRIPTION, isDeferred: true }
  })

  on('command.run', { command: 'question-pane' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Use /question-pane on, off, or nothing to flip it.' }
    const isOn = arg === '' ? !(await read($, enabled)) : arg === 'on'
    await setEnabled($, isOn)
    $.ui.toast(isOn ? 'Question form is on' : 'Question form is off: Claude asks in chat')
    return { text: `Question form is ${isOn ? 'on' : 'off'}.` }
  })

  on('command.run', { command: 'questions' }, async $ => {
    if ((await read($, form)) === null) return { text: 'There is no open question form.' }
    await $.ui.open({ id: PANE, title: 'Questions for you', focus: true, rows: 30, columns: 90 })
    return { text: 'Question form reopened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const f = await read($, form)
    if (f === null) return <Text dimColor>No questions waiting.</Text>
    // The mobile app draws no text field yet.
    if (!('Input' in elements)) {
      return <Text>{`Claude has ${f.questions.length} questions for you. Open this session in the terminal or desktop app to answer them.`}</Text>
    }
    const { Input } = elements

    const submit = async () => {
      const current = await read($, form)
      if (current === null) return
      // Send first: a pane that fails to close must not lose the answers.
      await update($, form, () => null)
      await $.prompt.submit({ text: formatAnswers(current), asUser: true })
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }

    let section: string | undefined
    const rows: RenderChildren[] = []
    f.questions.forEach((q, i) => {
      if (q.section !== undefined && q.section !== section) {
        section = q.section
        rows.push(
          <Box marginTop={1}>
            <Text bold underline>{q.section}</Text>
          </Box>,
        )
      }
      const isLast = i === f.questions.length - 1
      rows.push(
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{`${i + 1}. ${q.text}`}</Text>
          <Input
            key={`answer:${i}`}
            placeholder="Type your answer"
            value={f.answers[i]}
            submitLabel={isLast ? 'to Submit' : 'next'}
            autoFocus={i === 0 ? true : undefined}
            onInput={(value: string) => void update($, form, x => (x === null ? x : setAnswer(x, i, value)))}
            onSubmit={(value: string) => {
              void (async () => {
                await update($, form, x => (x === null ? x : setAnswer(x, i, value)))
                await $.ui.focus({ requestId: PANE, key: isLast ? 'submit' : `answer:${i + 1}` })
              })()
            }}
          />
        </Box>,
      )
    })

    return (
      <Box flexDirection="column">
        <Text bold>{f.title}</Text>
        <Text dimColor>Tab or Enter moves to the next answer. Blank answers are sent as "(no answer)".</Text>
        {rows}
        <Box marginTop={1} flexDirection="row" gap={2}>
          <Button key="submit" label="Submit" onPress={() => void submit()} />
          <Text dimColor>{`${answeredCount(f)} of ${f.questions.length} answered`}</Text>
        </Box>
      </Box>
    )
  })
}
