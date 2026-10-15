export type Question = { text: string; section?: string }

export type Form = {
  title: string
  questions: Question[]
  answers: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'question-pane': { form: Form | null; enabled: boolean }
  }
}
