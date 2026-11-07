import { useSyncExternalStore } from 'react'

// 두 손가락 확대 등으로 화면이 확대되었는지 돌려준다. visualViewport가 없는 환경에서는 false다.
function subscribe(onChange: () => void) {
  const viewport = window.visualViewport
  if (!viewport) return () => {}
  viewport.addEventListener('resize', onChange)
  return () => viewport.removeEventListener('resize', onChange)
}

function getSnapshot() {
  return (window.visualViewport?.scale ?? 1) > 1.01
}

export function useIsPageZoomed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
