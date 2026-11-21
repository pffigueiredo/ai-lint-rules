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
  username: string
}

export type FieldMessages = {
  email: string
  password: string
  displayName: string
  username: string
}

export const emptyDraft: SignupDraft = { email: '', password: '', displayName: '', username: '' }
export const emptyMessages: FieldMessages = { email: '', password: '', displayName: '', username: '' }

export function fieldMessages(draft: SignupDraft): FieldMessages {
  return {
    email: draft.email.length === 0 || !draft.email.includes('@') ? 'Enter an email' : '',
    password: draft.password.length < 8 ? 'Password must be at least 8 characters' : '',
    displayName: draft.displayName.length === 0 ? 'Enter a display name' : '',
    username: '',
  }
}

export function hasMessages(messages: FieldMessages): boolean {
  return (
    messages.email.length > 0 ||
    messages.password.length > 0 ||
    messages.displayName.length > 0 ||
    messages.username.length > 0
  )
}

export function parseSignupDraft(raw: string): SignupDraft | undefined {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(v)) return undefined
  const email = v['email']
  const password = v['password']
  const displayName = v['displayName']
  const username = v['username']
  if (typeof email !== 'string' || typeof password !== 'string') return undefined
  if (typeof displayName !== 'string' || typeof username !== 'string') return undefined
  return { email, password, displayName, username }
}

export function parseAvailability(body: unknown): { available: 'yes' | 'no' } {
  if (!isRecord(body) || typeof body['available'] !== 'boolean') throw new Error('shape')
  return { available: body['available'] ? 'yes' : 'no' }
}

export function parseServerErrors(body: unknown): FieldMessages {
  const out = { ...emptyMessages }
  if (!isRecord(body) || !isRecord(body['errors'])) return out
  const errors = body['errors']
  const pick = (key: keyof FieldMessages): string => {
    const v = errors[key]
    return typeof v === 'string' ? v : ''
  }
  out.email = pick('email')
  out.password = pick('password')
  out.displayName = pick('displayName')
  out.username = pick('username')
  return out
}

export class SignupInvalidError extends Error {
  readonly fieldErrors: FieldMessages
  constructor(fieldErrors: FieldMessages) {
    super('invalid')
    this.fieldErrors = fieldErrors
  }
}
