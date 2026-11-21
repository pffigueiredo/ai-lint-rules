import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath } from './render-app.tsx'

function searchOf(input: RequestInfo | URL): URLSearchParams {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(href, 'http://localhost').searchParams
}

function deferred(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function usernameCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/username')
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function stubApi(opts?: {
  username?: (u: string) => { available?: boolean; status?: number } | Promise<Response>
  signupStatus?: number
}): void {
  const signupStatus = opts?.signupStatus ?? 200
  const username = opts?.username
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/profile' && method === 'GET') return jsonResponse({}, 404)
      if (path === '/api/username' && method === 'GET') {
        const u = searchOf(input).get('u') ?? ''
        if (username === undefined) return jsonResponse({ available: true })
        const result = username(u)
        if (result instanceof Promise) return result
        return jsonResponse({ available: result.available ?? true }, result.status ?? 200)
      }
      if (path === '/api/signup' && method === 'POST') return jsonResponse({ ok: true }, signupStatus)
      return jsonResponse({ error: 'missing' }, 404)
    }),
  )
}

async function fillBase(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), 'ada@example.com')
  await user.type(screen.getByLabelText('Password'), 'secretsecret')
  await user.type(screen.getByLabelText('Display name'), 'Ada')
}

beforeEach(() => {
  setPath('/')
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setPath('/')
  localStorage.clear()
})

describe('core', () => {
  it('does not request availability until 300 ms after the last change', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi()
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(usernameCalls(fetchMock)).toHaveLength(0)
    await flush(299)
    expect(usernameCalls(fetchMock)).toHaveLength(0)
    await flush(1)
    await waitFor(() => {
      expect(usernameCalls(fetchMock)).toHaveLength(1)
    })
    expect(searchOf(usernameCalls(fetchMock)[0]?.[0] as RequestInfo | URL).get('u')).toBe('ada')
  })

  it('restarts the 300 ms wait when Username changes again', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi()
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    await flush(200)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada1' } })
    await flush(200)
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(usernameCalls(fetchMock)).toHaveLength(0)
    await flush(100)
    await waitFor(() => {
      expect(usernameCalls(fetchMock)).toHaveLength(1)
    })
    expect(searchOf(usernameCalls(fetchMock)[0]?.[0] as RequestInfo | URL).get('u')).toBe('ada1')
  })

  it('ignores a taken response for a previous username', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ada = deferred()
    const ada1 = deferred()
    stubApi({
      username: u => {
        if (u === 'ada') return ada.promise
        if (u === 'ada1') return ada1.promise
        return { available: true }
      },
    })
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada1' } })
    await flush(300)
    ada.resolve(jsonResponse({ available: false }))
    ada1.resolve(jsonResponse({ available: true }))
    expect(await screen.findByText('Username is available')).toBeTruthy()
    expect(screen.queryByText('Username is taken')).toBeNull()
  })

  it('disables Create account and shows Checking username after a change', async () => {
    stubApi({ username: () => deferred().promise })
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    expect(await screen.findByText('Checking username')).toBeTruthy()
    expect(submitButton().disabled).toBe(true)
  })

  it('keeps Create account disabled when the username is taken', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi({ username: () => ({ available: false }) })
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    expect(await screen.findByText('Username is taken')).toBeTruthy()
    expect(submitButton().disabled).toBe(true)
  })

  it('enables Create account when the username is available', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi({ username: () => ({ available: true }) })
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    expect(await screen.findByText('Username is available')).toBeTruthy()
    expect(submitButton().disabled).toBe(false)
  })

  it('does not request availability when Username is empty', async () => {
    stubApi()
    renderApp(<App />)
    await screen.findByLabelText('Username')
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(usernameCalls(fetchMock)).toHaveLength(0)
    expect(submitButton().disabled).toBe(false)
  })
})

describe('error', () => {
  it('shows Could not check username when the request fails', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi({ username: () => ({ status: 500 }) })
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    expect(await screen.findByText('Could not check username')).toBeTruthy()
    expect(submitButton().disabled).toBe(true)
  })

  it('does not POST when the username is taken', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi({ username: () => ({ available: false }) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderApp(<App />)
    await fillBase(user)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    await screen.findByText('Username is taken')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/signup' && requestMethod(init as RequestInit) === 'POST'
    })
    expect(post).toBeUndefined()
  })
})

describe('functionality', () => {
  it('hides the previous availability line when Username changes', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi({ username: () => ({ available: true }) })
    renderApp(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    expect(await screen.findByText('Username is available')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada1' } })
    expect(screen.queryByText('Username is available')).toBeNull()
    expect(screen.getByText('Checking username')).toBeTruthy()
  })

  it('posts username on a valid submit', { timeout: 8000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubApi({ username: () => ({ available: true }) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderApp(<App />)
    await fillBase(user)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } })
    await flush(300)
    await screen.findByText('Username is available')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Account created')).toBeTruthy()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find(([input, init]) => {
      return requestPath(input as RequestInfo | URL) === '/api/signup' && requestMethod(init as RequestInit) === 'POST'
    })
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body)) as { username?: string }
    expect(body['username']).toBe('ada')
  })

  it('still runs the other field checks when Username is empty', async () => {
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter an email')).toBeTruthy()
    expect(screen.getByText('Password must be at least 8 characters')).toBeTruthy()
    expect(screen.getByText('Enter a display name')).toBeTruthy()
  })

  it('keeps Username on step 1', async () => {
    setPath('/?step=1')
    stubApi()
    renderApp(<App />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Username')).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
})
