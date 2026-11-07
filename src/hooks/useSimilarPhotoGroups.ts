import { useEffect, useMemo, useState } from 'react'
import type { Photo } from '../photos/photo.ts'
import type { PhotoFingerprint } from '../photos/photoFingerprint.ts'
import { createSimilarityIndex, type SimilarGroupKind } from '../photos/similarPhotoGroups.ts'
import type { PhotoAnalysis } from '../photos/sharpnessWorkerClient.ts'

// 메인 스레드에서 한 번에 비교하는 최대 시간(ms). 이보다 길면 다음 차례로 넘겨 화면 반응을 막지 않는다.
export const SIMILARITY_WORK_SLICE_MS = 8
// 비교가 길게 이어질 때 화면의 묶음을 새로 그리는 최소 간격(ms)
const PROGRESS_PUBLISH_INTERVAL_MS = 250

export interface DisplayedSimilarGroup {
  readonly kind: SimilarGroupKind
  // 갤러리 순서(가져온 순서)의 사진
  readonly photos: readonly Photo[]
}

export interface SimilarPhotosState {
  // 첫 사진의 갤러리 순서로 정렬한 묶음
  readonly groups: readonly DisplayedSimilarGroup[]
  // 분석 결과가 없거나 다른 사진과의 비교가 끝나지 않은 사진 수
  readonly checkingCount: number
  // 분석하지 못했거나, 윤곽이 부족하거나, 비슷한 후보가 너무 많아 비교하지 않은 사진 수
  readonly uncomparedCount: number
}

// 사진 목록과 분석 결과로 비슷한 사진 묶음을 만든다. 비교 결과를 기억해 새로 분석된 사진만 기존 사진과 비교하고,
// 목록에서 빠진 사진은 묶음과 비교 결과에서 함께 뺀다. 비교는 짧은 조각으로 나눠 실행한다.
// 결과는 사진 목록·분석 결과와 섞지 않는 화면용 값이다.
export function useSimilarPhotoGroups(
  photos: readonly Photo[],
  analyses: ReadonlyMap<string, PhotoAnalysis>,
): SimilarPhotosState {
  // 비교 결과를 기억하는 색인. 컴포넌트가 있는 동안 같은 객체를 쓴다.
  const [index] = useState(createSimilarityIndex)
  // 나눠 실행한 비교가 진행되면 올려서 묶음을 다시 계산한다.
  const [progress, setProgress] = useState(0)

  const state = useMemo((): SimilarPhotosState => {
    // 색인은 React 바깥에서 바뀌므로 비교가 진행된 횟수(progress)가 바뀔 때마다 다시 읽는다.
    void progress
    // sync는 넘긴 목록과 같게 맞추고 비교를 예약할 뿐이라 같은 입력으로 여러 번 불러도 결과가 같다(StrictMode 이중 실행 포함).
    const fingerprints = new Map<string, PhotoFingerprint>()
    let waitingForAnalysis = 0
    for (const photo of photos) {
      const analysis = analyses.get(photo.id)
      if (!analysis) waitingForAnalysis += 1
      else if (analysis.fingerprint) fingerprints.set(photo.id, analysis.fingerprint)
    }
    index.sync(fingerprints)

    let uncomparedCount = 0
    for (const photo of photos) {
      const analysis = analyses.get(photo.id)
      if (analysis && (!analysis.fingerprint || index.statusOf(photo.id) !== 'comparable')) uncomparedCount += 1
    }

    const position = new Map(photos.map((photo, order) => [photo.id, order]))
    const photoById = new Map(photos.map((photo) => [photo.id, photo]))
    const groups = index
      .groups()
      .map((group) => ({
        kind: group.kind,
        photos: [...group.photoIds].sort((a, b) => position.get(a)! - position.get(b)!).map((id) => photoById.get(id)!),
      }))
      .sort((a, b) => position.get(a.photos[0]!.id)! - position.get(b.photos[0]!.id)!)
    return { groups, checkingCount: waitingForAnalysis + index.pendingCount, uncomparedCount }
  }, [index, photos, analyses, progress])

  // 남은 비교가 있으면 조각으로 나눠 실행하고, 끝나거나 일정 시간이 지나면 화면에 반영한다.
  const hasPendingComparisons = state.checkingCount > 0 && index.pendingCount > 0
  useEffect(() => {
    // state가 바뀔 때마다(사진 추가·제거, 진행 반영) 예약을 새로 한다.
    if (!hasPendingComparisons) return
    let timer: ReturnType<typeof setTimeout>
    let lastPublished = performance.now()
    const step = () => {
      const isDone = index.work(SIMILARITY_WORK_SLICE_MS)
      if (isDone || performance.now() - lastPublished >= PROGRESS_PUBLISH_INTERVAL_MS) {
        lastPublished = performance.now()
        setProgress((value) => value + 1)
      }
      if (!isDone) timer = setTimeout(step, 0)
    }
    timer = setTimeout(step, 0)
    return () => clearTimeout(timer)
  }, [index, state, hasPendingComparisons])

  return state
}
