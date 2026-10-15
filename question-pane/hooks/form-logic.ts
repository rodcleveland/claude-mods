import type { Form, Question } from '../types'

export const MAX_QUESTIONS = 40

// The tool's input, read loosely: a list of strings or of { text, section } objects.
export function readQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() !== '') out.push({ text: item.trim() })
    else if (item !== null && typeof item === 'object') {
      const { text, section } = item as { text?: unknown; section?: unknown }
      if (typeof text !== 'string' || text.trim() === '') continue
      const q: Question = { text: text.trim() }
      if (typeof section === 'string' && section.trim() !== '') q.section = section.trim()
      out.push(q)
    }
  }
  return out.slice(0, MAX_QUESTIONS)
}

export function newForm(title: unknown, questions: Question[]): Form {
  const name = typeof title === 'string' && title.trim() !== '' ? title.trim() : 'Questions'
  return { title: name, questions, answers: questions.map(() => '') }
}

export function setAnswer(form: Form, index: number, value: string): Form {
  if (index < 0 || index >= form.answers.length) return form
  const answers = form.answers.slice()
  answers[index] = value
  return { ...form, answers }
}

export function answeredCount(form: Form): number {
  return form.answers.filter(a => a.trim() !== '').length
}

// The message Claude receives: each question with its answer under it.
export function formatAnswers(form: Form): string {
  const lines = [`My answers to "${form.title}":`, '']
  let section: string | undefined
  form.questions.forEach((q, i) => {
    if (q.section !== undefined && q.section !== section) {
      section = q.section
      lines.push(`## ${q.section}`, '')
    }
    const answer = form.answers[i]?.trim() ?? ''
    lines.push(`${i + 1}. ${q.text}`)
    lines.push(`   Answer: ${answer === '' ? '(no answer)' : answer}`, '')
  })
  return lines.join('\n').trimEnd()
}
