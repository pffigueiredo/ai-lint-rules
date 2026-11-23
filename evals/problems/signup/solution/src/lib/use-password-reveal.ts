import { useState } from 'react'

export function usePasswordReveal() {
  const [visibility, setVisibility] = useState<'hidden' | 'shown'>('hidden')
  function toggle(): void {
    setVisibility(v => (v === 'hidden' ? 'shown' : 'hidden'))
  }
  return { visibility, toggle }
}
