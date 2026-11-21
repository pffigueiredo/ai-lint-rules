import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath, shown } from './render-app.tsx'

const PROFILE = { email: 'ada@example.com', displayName: 'Ada' }

function stubApi(opts?: { profile?: typeof PROFILE | 'fail'; saveStatus?: number }): void {
  const saveStatus = opts?.saveStatus ?? 200
  let profile: typeof PROFILE | 'fail' = opts?.profile ?? 'fail'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/profile' && method === 'GET') {
        if (profile === 'fail') return jsonResponse({}, 404)
        return jsonResponse(profile)
      }
      if (path === '/api/profile' && method === 'PUT') {
        if (saveStatus === 200 && init?.body !== undefined) {
          const parsed: unknown = JSON.parse(String(init.body))
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'email' in parsed &&
            'displayName' in parsed &&
            typeof parsed.email === 'string' &&
            typeof parsed.displayName === 'string'
          ) {
            profile = { email: parsed.email, displayName: parsed.displayName }
          }
        }
        return jsonResponse({ ok: true }, saveStatus)
      }
      if (path === '/api/signup' && method === 'POST') return jsonResponse({ ok: true })
      return jsonResponse({ error: 'missing' }, 404)
    }),
  )
}

function query(): URLSearchParams {
  return new URLSearchParams(window.location.search)
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
  it('shows the profile heading after a successful profile load', async () => {
    stubApi({ profile: PROFILE })
    renderApp(<App />)
    expect(await screen.findByRole('region', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Ada' })).toBeTruthy()
    expect(screen.getByText('ada@example.com')).toBeTruthy()
    expect(screen.queryAllByLabelText('Password').some(shown)).toBe(false)
  })

  it('shows edit fields when mode=edit', async () => {
    setPath('/?mode=edit')
    stubApi({ profile: PROFILE })
    renderApp(<App />)
    expect(await screen.findByRole('region', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('reveals the password field on the signup form', async () => {
    stubApi({ profile: 'fail' })
    const user = userEvent.setup()
    renderApp(<App />)
    const input = await screen.findByLabelText('Password')
    expect((input as HTMLInputElement).type).toBe('password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect((input as HTMLInputElement).type).toBe('text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy()
  })
})

describe('error', () => {
  it('alerts when saving the profile fails', async () => {
    setPath('/?mode=edit')
    stubApi({ profile: PROFILE, saveStatus: 500 })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not save profile')).toBeTruthy()
  })
})

describe('functionality', () => {
  it('writes mode=edit when Edit is clicked', async () => {
    stubApi({ profile: PROFILE })
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => {
      expect(query().get('mode')).toBe('edit')
    })
  })

  it('has no text boxes in view', async () => {
    stubApi({ profile: PROFILE })
    renderApp(<App />)
    expect(await screen.findByRole('region', { name: 'Profile' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('treats a missing mode as view', async () => {
    stubApi({ profile: PROFILE })
    renderApp(<App />)
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('shows the saved display name and email after Save', async () => {
    setPath('/?mode=edit')
    stubApi({ profile: PROFILE })
    const user = userEvent.setup()
    renderApp(<App />)
    expect(await screen.findByRole('region', { name: 'Profile' })).toBeTruthy()
    const name = screen.getByLabelText('Display name')
    await user.clear(name)
    await user.type(name, 'Ada Lovelace')
    const email = screen.getByLabelText('Email')
    await user.clear(email)
    await user.type(email, 'ada2@example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeTruthy()
    expect(screen.getByText('ada2@example.com')).toBeTruthy()
  })

  it('hides the password again', async () => {
    stubApi({ profile: 'fail' })
    const user = userEvent.setup()
    renderApp(<App />)
    const input = await screen.findByLabelText('Password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect((input as HTMLInputElement).type).toBe('password')
  })
})
