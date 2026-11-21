import type { FormEvent } from 'react'
import { fieldMessages, hasMessages } from './lib/parse'
import { usePasswordReveal } from './lib/use-password-reveal'
import { useProfile, useSaveProfile } from './lib/use-profile'
import { useSearchParams, writeParam } from './lib/use-search-params'
import { useSignup } from './lib/use-signup'
import { useSignupDraft } from './lib/use-signup-draft'

function SignupForm() {
  const [params, setParams] = useSearchParams()
  const draftState = useSignupDraft()
  const reveal = usePasswordReveal()
  const signup = useSignup()
  const stepRaw = params.get('step')
  const step = stepRaw === '1' || stepRaw === '2' || stepRaw === '3' ? Number(stepRaw) : undefined
  const showEmail = step === undefined || step === 1
  const showPassword = step === undefined || step === 2
  const showName = step === undefined || step === 3
  const showSubmit = step === undefined || step === 3
  const draft = draftState.draft
  const messages = draftState.messages

  function onSubmit(e: FormEvent): void {
    e.preventDefault()
    const next = fieldMessages(draft)
    draftState.setMessages(next)
    if (hasMessages(next)) return
    signup.mutate(draft)
  }

  if (signup.isSuccess) return <p>Account created</p>

  return (
    <form onSubmit={onSubmit}>
      {showEmail ? (
        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            value={draft.email}
            onChange={e => draftState.setDraft({ ...draft, email: e.target.value })}
          />
        </div>
      ) : null}
      {showPassword ? (
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type={reveal.visibility === 'shown' ? 'text' : 'password'}
            value={draft.password}
            onChange={e => draftState.setDraft({ ...draft, password: e.target.value })}
          />
          <button type="button" onClick={reveal.toggle}>
            {reveal.visibility === 'shown' ? 'Hide password' : 'Show password'}
          </button>
        </div>
      ) : null}
      {showName ? (
        <div>
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            value={draft.displayName}
            onChange={e => draftState.setDraft({ ...draft, displayName: e.target.value })}
          />
        </div>
      ) : null}
      {messages.email.length > 0 ? <p>{messages.email}</p> : null}
      {messages.password.length > 0 ? <p>{messages.password}</p> : null}
      {messages.displayName.length > 0 ? <p>{messages.displayName}</p> : null}
      {step === 2 || step === 3 ? (
        <button type="button" onClick={() => setParams(writeParam(params, 'step', String((step ?? 1) - 1)))}>
          Back
        </button>
      ) : null}
      {step === 1 || step === 2 ? (
        <button type="button" onClick={() => setParams(writeParam(params, 'step', String((step ?? 1) + 1)))}>
          Next
        </button>
      ) : null}
      {showSubmit ? <button type="submit">Create account</button> : null}
      {signup.isError ? <div role="alert">Could not create account</div> : null}
    </form>
  )
}

function ProfilePane() {
  const profile = useProfile()
  const save = useSaveProfile()
  const [params, setParams] = useSearchParams()
  const mode = params.get('mode') === 'edit' ? 'edit' : 'view'
  if (!profile.isSuccess) return null
  const data = profile.data
  return (
    <section aria-label="Profile">
      <h2>{data.displayName}</h2>
      <p>{data.email}</p>
      <button type="button" onClick={() => setParams(writeParam(params, 'mode', 'view'))}>
        View
      </button>
      <button type="button" onClick={() => setParams(writeParam(params, 'mode', 'edit'))}>
        Edit
      </button>
      {mode === 'edit' ? (
        <form
          onSubmit={e => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            const displayName = fd.get('display-name')
            const email = fd.get('email')
            if (typeof displayName !== 'string' || typeof email !== 'string') return
            save.mutate({ displayName, email })
          }}
        >
          <label htmlFor="profile-display-name">Display name</label>
          <input id="profile-display-name" name="display-name" defaultValue={data.displayName} />
          <label htmlFor="profile-email">Email</label>
          <input id="profile-email" name="email" defaultValue={data.email} />
          <button type="submit">Save</button>
        </form>
      ) : null}
      {save.isError ? <div role="alert">Could not save profile</div> : null}
    </section>
  )
}

export default function App() {
  const profile = useProfile()
  if (profile.isPending) return null
  if (profile.isSuccess) return <ProfilePane />
  return <SignupForm />
}
