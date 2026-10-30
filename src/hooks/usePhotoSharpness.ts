import type { Photo } from '../photos/photo.ts'
import type { SharpnessResult } from '../photos/sharpness.ts'
import type { SharpnessAnalyzer } from '../photos/sharpnessWorkerClient.ts'
import { usePhotoAnalysis } from './usePhotoAnalysis.ts'

const FAILED: SharpnessResult = { status: 'unavailable', reason: 'failed' }
const selectVerdict = (analyzer: SharpnessAnalyzer) => analyzer.analyze

// 갤러리에 표시할 사진별 흐림 판정. 결과가 없는 사진은 분석 중이다.
export function usePhotoSharpness(photos: readonly Photo[]): ReadonlyMap<string, SharpnessResult> {
  return usePhotoAnalysis(photos, selectVerdict, FAILED)
}
