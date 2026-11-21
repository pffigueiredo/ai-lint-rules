import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath, shown } from './render-app.tsx'

function stubApi(opts?: { signupStatus?: number }): void {
  const signupStatus = opts?.signupStatus ?? 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/profile' && method === 'GET') return jsonResponse({}, 404)
      if (path === '/api/signup' && method === 'POST') return jsonResponse({ ok: true }, signupStatus)
      return jsonResponse({ error: 'missing' }, 404)
    }),
  )
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
  it('renders the labelled fields and submit button', async () => {
    stubApi()
    renderApp(<App />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy()
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password')
  })

  it('posts a valid form and shows Account created', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Account created')).toBeTruthy()
    expect(screen.queryAllByLabelText('Email').some(shown)).toBe(false)
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/signup' && requestMethod(init as RequestInit) === 'POST'
    })
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>
    expect(body['email']).toBe('ada@example.com')
    expect(body['password']).toBe('secretsecret')
    expect(body['displayName']).toBe('Ada')
  })
})

describe('error', () => {
  it('shows field messages and does not POST when email is missing', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter an email')).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/signup' && requestMethod(init as RequestInit) === 'POST'
    })
    expect(post).toBeUndefined()
  })

  it('alerts when signup fails', async () => {
    stubApi({ signupStatus: 500 })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not create account')).toBeTruthy()
    expect(screen.getByLabelText('Email')).toBeTruthy()
  })
})

describe('functionality', () => {
  it('rejects an email with no @', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada.example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter an email')).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/signup' && requestMethod(init as RequestInit) === 'POST'
    })
    expect(post).toBeUndefined()
  })

  it('does not retry a failed signup', async () => {
    stubApi({ signupStatus: 500 })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'secretsecret')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const posts = fetchMock.mock.calls.filter(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/signup' && requestMethod(init as RequestInit) === 'POST'
    })
    expect(posts).toHaveLength(1)
  })

  it('rejects a short password and a missing display name', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Password must be at least 8 characters')).toBeTruthy()
    expect(screen.getByText('Enter a display name')).toBeTruthy()
  })
})
