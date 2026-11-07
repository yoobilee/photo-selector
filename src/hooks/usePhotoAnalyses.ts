import type { Photo } from '../photos/photo.ts'
import type { PhotoAnalysis, SharpnessAnalyzer } from '../photos/sharpnessWorkerClient.ts'
import { usePhotoAnalysis } from './usePhotoAnalysis.ts'

const FAILED: PhotoAnalysis = { sharpness: { status: 'unavailable', reason: 'failed' }, fingerprint: null }
const selectPhotoAnalysis = (analyzer: SharpnessAnalyzer) => analyzer.analyzePhoto

// 갤러리에 표시할 사진별 흐림 판정과 비슷한 사진 지문. 사진마다 한 번 디코딩한 이미지로 함께 계산한다. 결과가 없는 사진은 분석 중이다.
export function usePhotoAnalyses(photos: readonly Photo[]): ReadonlyMap<string, PhotoAnalysis> {
  return usePhotoAnalysis(photos, selectPhotoAnalysis, FAILED)
}
