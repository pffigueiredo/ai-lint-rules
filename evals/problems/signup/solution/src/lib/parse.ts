export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export type Profile = {
  email: string
  displayName: string
}

export function parseProfile(body: unknown): Profile {
  if (!isRecord(body)) throw new Error('shape')
  const email = body['email']
  const displayName = body['displayName']
  if (typeof email !== 'string' || typeof displayName !== 'string') throw new Error('shape')
  return { email, displayName }
}

export type SignupDraft = {
  email: string
  password: string
  displayName: string
}

export type FieldMessages = {
  email: string
  password: string
  displayName: string
}

export function fieldMessages(draft: SignupDraft): FieldMessages {
  return {
    email: draft.email.length === 0 || !draft.email.includes('@') ? 'Enter an email' : '',
    password: draft.password.length < 8 ? 'Password must be at least 8 characters' : '',
    displayName: draft.displayName.length === 0 ? 'Enter a display name' : '',
  }
}

export function hasMessages(messages: FieldMessages): boolean {
  return messages.email.length > 0 || messages.password.length > 0 || messages.displayName.length > 0
}
