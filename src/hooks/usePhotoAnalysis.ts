import { useEffect, useRef, useState } from 'react'
import type { Photo } from '../photos/photo.ts'
import { createAnalysisQueue, type AnalysisQueue } from '../photos/sharpnessQueue.ts'
import { createSharpnessWorkerAnalyzer, type SharpnessAnalyzer } from '../photos/sharpnessWorkerClient.ts'

// 사진 목록과 별도로 사진별 분석 결과를 관리한다. 결과가 없는 사진은 분석 중이다.
// 원본 File은 Worker에 읽기용으로 전달할 뿐 바꾸지 않으며, 분석 결과는 사진 목록·원본 데이터와 섞지 않는다.
// select는 분석기에서 어떤 결과를 쓸지 고른다(사용자 화면은 판정만, 평가 도구는 측정값까지). 렌더마다 바뀌지 않아야 한다.
export function usePhotoAnalysis<T>(
  photos: readonly Photo[],
  select: (analyzer: SharpnessAnalyzer) => (file: Blob) => Promise<T>,
  failed: T,
): ReadonlyMap<string, T> {
  const [results, setResults] = useState<ReadonlyMap<string, T>>(() => new Map())
  // 비동기 결과와 effect에서 최신 값을 읽기 위한 사본
  const resultsRef = useRef<ReadonlyMap<string, T>>(results)
  const liveIdsRef = useRef<ReadonlySet<string>>(new Set())
  const queueRef = useRef<AnalysisQueue<T> | null>(null)
  // 마운트할 때의 선택과 실패값만 쓴다. 이후 바뀌어도 진행 중인 큐를 다시 만들지 않는다.
  const setupRef = useRef({ select, failed })

  // 언마운트하면 대기 중인 분석을 버리고 Worker를 종료한다.
  useEffect(() => {
    const analyzer = createSharpnessWorkerAnalyzer()
    const queue = createAnalysisQueue(setupRef.current.select(analyzer), setupRef.current.failed)
    queueRef.current = queue
    return () => {
      queue.dispose()
      analyzer.dispose()
      if (queueRef.current === queue) queueRef.current = null
    }
  }, [])

  // 새 사진은 한 번만 분석을 예약하고, 목록에서 빠진 사진의 분석은 취소한다.
  useEffect(() => {
    const queue = queueRef.current
    if (!queue) return
    const liveIds = new Set(photos.map((photo) => photo.id))
    for (const id of liveIdsRef.current) if (!liveIds.has(id)) queue.cancel(id)
    liveIdsRef.current = liveIds

    for (const photo of photos) {
      if (resultsRef.current.has(photo.id) || queue.has(photo.id)) continue
      queue.enqueue(photo.id, photo.source, (result) => {
        // 제거된 사진의 결과는 함께 정리한다. 사진 id는 다시 쓰이지 않는다.
        const next = new Map([...resultsRef.current].filter(([id]) => liveIdsRef.current.has(id)))
        next.set(photo.id, result)
        resultsRef.current = next
        setResults(next)
      })
    }
  }, [photos])

  return results
}
