import { unavailableReasonText } from '../components/sharpnessText.ts'
import type { UnavailableReason } from '../photos/sharpness.ts'
import type { AnalysisPath } from '../photos/sharpnessWorkerClient.ts'
import type { SceneCondition } from './evaluationExport.ts'
import type { AutomaticVerdict, GroundTruth, Outcome, Proportion } from './evaluationMetrics.ts'

export const groundTruthText: Record<GroundTruth, string> = {
  sharp: '선명',
  blurry: '흐림',
  unsure: '판단 보류',
}

export const sceneConditionText: Record<SceneCondition, string> = {
  outdoor: '야외',
  indoor: '실내',
  'low-light': '야간·저조도',
  'camera-shake': '손떨림',
  'out-of-focus': '초점 불일치',
  'portrait-bokeh': '인물·배경 흐림',
  'landscape-sky': '풍경·넓은 하늘',
  texture: '질감 많은 피사체',
  other: '기타',
}

export const verdictText: Record<AutomaticVerdict, string> = {
  sharp: '선명',
  blurry: '흐림 의심',
  unavailable: '분석 불가',
  pending: '분석 중',
}

export const outcomeText: Record<Outcome, string> = {
  'true-positive': '정상(흐림)',
  'true-negative': '정상(선명)',
  'false-positive': '오탐',
  'false-negative': '미탐',
  unavailable: '분석 불가',
  pending: '분석 중',
  unsure: '판단 보류',
  unlabeled: '정답 없음',
}

export const analysisPathText: Record<AnalysisPath, string> = {
  worker: 'Web Worker에서 디코딩·계산',
  'main-thread-decode': '메인 스레드에서 디코딩·축소, Web Worker에서 계산',
  unsupported: '분석 불가(Web Worker 없음)',
}

export const describeUnavailableReason = (reason: UnavailableReason) => unavailableReasonText[reason]

const percent = (value: number) => `${(value * 100).toFixed(1)}%`

export function formatProportion({ numerator, denominator, value }: Proportion): string {
  return value === null ? '계산 불가(0장)' : `${percent(value)} (${numerator}/${denominator})`
}

export function formatInterval({ interval }: Proportion): string {
  return interval ? `${percent(interval.low)} ~ ${percent(interval.high)}` : '—'
}
