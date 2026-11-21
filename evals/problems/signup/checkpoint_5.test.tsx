import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath, shown } from './render-app.tsx'

const DRAFT = {
  email: 'ada@example.com',
  password: 'secretsecret',
  displayName: 'Ada',
  username: 'ada',
}

function stubApi(opts?: { signupStatus?: number; signupBody?: unknown }): void {
  const signupStatus = opts?.signupStatus ?? 200
  const signupBody = opts?.signupBody ?? { ok: true }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/profile' && method === 'GET') return jsonResponse({}, 404)
      if (path === '/api/username' && method === 'GET') return jsonResponse({ available: true })
      if (path === '/api/signup' && method === 'POST') return jsonResponse(signupBody, signupStatus)
      return jsonResponse({ error: 'missing' }, 404)
    }),
  )
}

function stored(): string | null {
  return localStorage.getItem('signup-draft')
}

beforeEach(() => {
  setPath('/')
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setPath('/')
  localStorage.clear()
})

describe('core', () => {
  it('writes signup-draft when Email changes', async () => {
    stubApi()
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } })
    expect(JSON.parse(String(stored()))).toMatchObject({ email: 'ada@example.com' })
  })

  it('fills the fields from signup-draft on load', async () => {
    localStorage.setItem('signup-draft', JSON.stringify(DRAFT))
    stubApi()
    renderApp(<App />)
    expect(((await screen.findByLabelText('Email')) as HTMLInputElement).value).toBe('ada@example.com')
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('secretsecret')
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ada')
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('ada')
  })

  it('Discard draft clears the fields and the key', async () => {
    localStorage.setItem('signup-draft', JSON.stringify(DRAFT))
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }))
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('')
    expect(stored()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })

  it('shows a 422 email message next to Email', async () => {
    stubApi({ signupStatus: 422, signupBody: { errors: { email: 'Email already used' } } })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect((await screen.findAllByText(/Email already used/)).some(shown)).toBe(true)
    expect(screen.queryByText('Could not create account')).toBeNull()
    expect(screen.getByLabelText(/^Email/)).toBeTruthy()
  })

  it('shows both 422 field messages', async () => {
    stubApi({
      signupStatus: 422,
      signupBody: { errors: { email: 'Email already used', username: 'Pick another username' } },
    })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect((await screen.findAllByText(/Email already used/)).some(shown)).toBe(true)
    expect(screen.getAllByText(/Pick another username/).some(shown)).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still alerts Could not create account on a non-422 failure', async () => {
    stubApi({ signupStatus: 500 })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not create account')).toBeTruthy()
  })

  it('removes signup-draft after a successful create', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    expect(stored()).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Account created')).toBeTruthy()
    expect(stored()).toBeNull()
  })
})

describe('error', () => {
  it('ignores a signup-draft value that is not JSON', async () => {
    localStorage.setItem('signup-draft', '{not json')
    stubApi()
    renderApp(<App />)
    expect(((await screen.findByLabelText('Email')) as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })

  it('ignores a signup-draft object missing a string field', async () => {
    localStorage.setItem('signup-draft', JSON.stringify({ email: 'ada@example.com', password: 'x' }))
    stubApi()
    renderApp(<App />)
    expect(((await screen.findByLabelText('Email')) as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })
})

describe('functionality', () => {
  it('does not show Discard draft when nothing is stored', async () => {
    stubApi()
    renderApp(<App />)
    await screen.findByLabelText('Email')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })

  it('writes password and display name into signup-draft', async () => {
    stubApi()
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'secretsecret' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada' } })
    expect(JSON.parse(String(stored()))).toMatchObject({ password: 'secretsecret', displayName: 'Ada' })
  })

  it('restores the password on step 2', async () => {
    localStorage.setItem('signup-draft', JSON.stringify(DRAFT))
    setPath('/?step=2')
    stubApi()
    renderApp(<App />)
    expect(((await screen.findByLabelText('Password')) as HTMLInputElement).value).toBe('secretsecret')
  })

  it('shows a 422 username message', async () => {
    stubApi({ signupStatus: 422, signupBody: { errors: { username: 'Pick another username' } } })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect((await screen.findAllByText(/Pick another username/)).some(shown)).toBe(true)
  })

  it('keeps Discard draft after a 422 response', async () => {
    stubApi({ signupStatus: 422, signupBody: { errors: { email: 'Email already used' } } })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect((await screen.findAllByText(/Email already used/)).some(shown)).toBe(true)
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeTruthy()
    expect(stored()).not.toBeNull()
  })

  it('hides 422 field messages after Discard draft', async () => {
    stubApi({ signupStatus: 422, signupBody: { errors: { email: 'Email already used' } } })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect((await screen.findAllByText(/Email already used/)).some(shown)).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    expect(screen.queryAllByText(/Email already used/).some(shown)).toBe(false)
  })
})
