import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './src/App'
import { jsonResponse, renderApp, requestMethod, requestPath, setPath } from './render-app.tsx'

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      const method = requestMethod(init)
      if (path === '/api/profile' && method === 'GET') return jsonResponse({}, 404)
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
  it('shows only email on step 1', async () => {
    setPath('/?step=1')
    stubApi()
    renderApp(<App />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByLabelText('Display name')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull()
  })

  it('moves to step 2 on Next', async () => {
    setPath('/?step=1')
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(query().get('step')).toBe('2')
    })
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  })

  it('submits from step 3', async () => {
    setPath('/?step=3')
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.type(await screen.findByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter an email')).toBeTruthy()
  })
})

describe('error', () => {
  it('keeps Create account off the first step', async () => {
    setPath('/?step=1')
    stubApi()
    renderApp(<App />)
    await screen.findByLabelText('Email')
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull()
  })
})

describe('functionality', () => {
  it('without step, still shows every field', async () => {
    stubApi()
    renderApp(<App />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByLabelText('Display name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy()
  })

  it('Back from step 2 writes step 1', async () => {
    setPath('/?step=2')
    stubApi()
    const user = userEvent.setup()
    renderApp(<App />)
    await user.click(await screen.findByRole('button', { name: 'Back' }))
    await waitFor(() => {
      expect(query().get('step')).toBe('1')
    })
  })
})
