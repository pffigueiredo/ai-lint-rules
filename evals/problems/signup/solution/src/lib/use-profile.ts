import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseProfile, type Profile } from './parse'

async function fetchProfile(): Promise<Profile> {
  const res = await fetch('/api/profile')
  if (!res.ok) throw new Error('load')
  return parseProfile(await res.json())
}

async function putProfile(body: Profile): Promise<void> {
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('save')
}

export function useProfile() {
  return useQuery({ queryKey: ['profile'], queryFn: fetchProfile })
}

export function useSaveProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: putProfile,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}
