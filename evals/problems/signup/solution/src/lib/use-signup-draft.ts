import { useState } from 'react'
import type { FieldMessages, SignupDraft } from './parse'

const emptyDraft: SignupDraft = { email: '', password: '', displayName: '' }
const emptyMessages: FieldMessages = { email: '', password: '', displayName: '' }

export function useSignupDraft() {
  const [draft, setDraft] = useState(emptyDraft)
  const [messages, setMessages] = useState(emptyMessages)
  return { draft, setDraft, messages, setMessages }
}
