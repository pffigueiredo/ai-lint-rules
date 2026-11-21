import { useMutation } from '@tanstack/react-query'
import { parseServerErrors, SignupInvalidError, type SignupDraft } from './parse'

async function postSignup(draft: SignupDraft): Promise<void> {
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: draft.email,
      password: draft.password,
      displayName: draft.displayName,
      username: draft.username,
    }),
  })
  if (res.status === 422) {
    throw new SignupInvalidError(parseServerErrors(await res.json()))
  }
  if (!res.ok) throw new Error('signup')
  localStorage.removeItem('signup-draft')
}

export function useSignup() {
  return useMutation({ mutationFn: postSignup })
}
