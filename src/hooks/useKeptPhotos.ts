import { useCallback, useMemo, useState } from 'react'
import type { Photo } from '../photos/photo.ts'

export interface KeptPhotos {
  // 사용자가 남기기로 표시한 사진 id. 목록에 있는 사진만 들어 있다.
  readonly keptIds: ReadonlySet<string>
  readonly setKept: (photoId: string, kept: boolean) => void
}

// 사용자가 직접 고른 '남길 사진'을 브라우저 메모리에만 기억한다. 흐림 판정·비슷한 사진 묶음과 섞지 않으며,
// 표시만 바꿀 뿐 사진을 지우거나 숨기지 않는다. 목록에서 제거한 사진은 남길 사진에서도 빠진다.
export function useKeptPhotos(photos: readonly Photo[]): KeptPhotos {
  const [storedIds, setStoredIds] = useState<ReadonlySet<string>>(() => new Set())

  // 사진 id는 세션 안에서 다시 쓰지 않으므로, 제거한 사진의 id는 목록과 맞춰 보는 것만으로 결과에서 빠진다.
  const keptIds = useMemo(() => {
    const present = new Set<string>()
    for (const photo of photos) if (storedIds.has(photo.id)) present.add(photo.id)
    return present.size === storedIds.size ? storedIds : present
  }, [photos, storedIds])

  const setKept = useCallback(
    (photoId: string, kept: boolean) => {
      // 바꿀 때 목록에 없는 id를 함께 정리해 기억하는 id가 계속 늘지 않게 한다.
      const presentIds = new Set(photos.map((photo) => photo.id))
      setStoredIds((previous) => {
        const next = new Set([...previous].filter((id) => presentIds.has(id)))
        if (kept && presentIds.has(photoId)) next.add(photoId)
        else next.delete(photoId)
        return next
      })
    },
    [photos],
  )

  return { keptIds, setKept }
}
