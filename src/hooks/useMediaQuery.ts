import { useCallback, useSyncExternalStore } from 'react'

// 화면 조건(CSS 미디어 쿼리)이 맞는지 돌려주고 바뀌면 다시 그린다. matchMedia가 없는 환경에서는 false다.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
