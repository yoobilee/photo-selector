import { useEffect, useRef, useState } from 'react'
import type { Photo } from '../photos/photo.ts'
import { createAnalysisQueue, type AnalysisQueue } from '../photos/sharpnessQueue.ts'
import { sha256Hex } from './fileHash.ts'
import type { PhotoHash } from './groundTruthMatch.ts'

const FAILED: PhotoHash = { status: 'failed' }
// 계산하는 동안 원본 파일 전체를 메모리에 잠시 올리므로 한 장씩 계산한다.
const HASH_CONCURRENCY = 1

const hashPhoto = async (file: Blob): Promise<PhotoHash> => ({ status: 'ready', sha256: await sha256Hex(file) })

// 사진별 원본 바이트 해시를 관리한다(개발용 평가 도구 전용). 결과가 없는 사진은 계산 중이다.
// 원본 File은 읽기만 하고, 해시는 이 화면의 메모리에만 둔다. 실패하면 failed로 두며 다른 사진 계산은 계속한다.
export function usePhotoHashes(photos: readonly Photo[]): ReadonlyMap<string, PhotoHash> {
  const [hashes, setHashes] = useState<ReadonlyMap<string, PhotoHash>>(() => new Map())
  // 비동기 결과와 effect에서 최신 값을 읽기 위한 사본
  const hashesRef = useRef<ReadonlyMap<string, PhotoHash>>(hashes)
  const liveIdsRef = useRef<ReadonlySet<string>>(new Set())
  const queueRef = useRef<AnalysisQueue<PhotoHash> | null>(null)

  // 언마운트하면 대기 중인 계산을 버린다.
  useEffect(() => {
    const queue = createAnalysisQueue(hashPhoto, FAILED, HASH_CONCURRENCY)
    queueRef.current = queue
    return () => {
      queue.dispose()
      if (queueRef.current === queue) queueRef.current = null
    }
  }, [])

  // 새 사진은 한 번만 계산을 예약하고, 목록에서 빠진 사진의 계산은 취소한다.
  useEffect(() => {
    const queue = queueRef.current
    if (!queue) return
    const liveIds = new Set(photos.map((photo) => photo.id))
    for (const id of liveIdsRef.current) if (!liveIds.has(id)) queue.cancel(id)
    liveIdsRef.current = liveIds

    for (const photo of photos) {
      if (hashesRef.current.has(photo.id) || queue.has(photo.id)) continue
      queue.enqueue(photo.id, photo.source, (hash) => {
        // 제거된 사진의 해시는 함께 정리한다. 사진 id는 다시 쓰이지 않는다.
        const next = new Map([...hashesRef.current].filter(([id]) => liveIdsRef.current.has(id)))
        next.set(photo.id, hash)
        hashesRef.current = next
        setHashes(next)
      })
    }
  }, [photos])

  return hashes
}
