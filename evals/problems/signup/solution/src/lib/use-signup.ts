import { useMutation } from '@tanstack/react-query'
import type { SignupDraft } from './parse'

async function postSignup(draft: SignupDraft): Promise<void> {
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: draft.email,
      password: draft.password,
      displayName: draft.displayName,
    }),
  })
  if (!res.ok) throw new Error('signup')
}

export function useSignup() {
  return useMutation({ mutationFn: postSignup })
}
