import { useState } from 'react'
import {
  emptyDraft,
  emptyMessages,
  parseSignupDraft,
  type FieldMessages,
  type SignupDraft,
} from './parse'

const KEY = 'signup-draft'

type Box = {
  draft: SignupDraft
  stored: 'yes' | 'no'
  messages: FieldMessages
}

function read(): { draft: SignupDraft; stored: 'yes' | 'no' } {
  const raw = localStorage.getItem(KEY)
  if (raw === null) return { draft: emptyDraft, stored: 'no' }
  const draft = parseSignupDraft(raw)
  if (draft === undefined) return { draft: emptyDraft, stored: 'no' }
  return { draft, stored: 'yes' }
}

export function useSignupDraft() {
  const [box, setBox] = useState<Box>(() => {
    const loaded = read()
    return { draft: loaded.draft, stored: loaded.stored, messages: emptyMessages }
  })

  function setDraft(next: SignupDraft): void {
    localStorage.setItem(KEY, JSON.stringify(next))
    setBox(current => ({ ...current, draft: next, stored: 'yes' }))
  }

  function setMessages(messages: FieldMessages): void {
    setBox(current => ({ ...current, messages }))
  }

  function discard(): void {
    localStorage.removeItem(KEY)
    setBox({ draft: emptyDraft, stored: 'no', messages: emptyMessages })
  }

  return {
    draft: box.draft,
    setDraft,
    messages: box.messages,
    setMessages,
    stored: box.stored,
    discard,
  }
}
