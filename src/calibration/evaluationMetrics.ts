// 흐림 판정 평가 통계. React·DOM에 의존하지 않는 순수 함수다.
// 양성(찾아야 하는 것)은 '흐림'이다. 사람이 붙인 정답과 자동 판정을 비교한다.

// 사람이 붙인 정답. 판단 보류는 정답이 없는 사진으로 보고 정확도 통계에서 뺀다.
export const groundTruths = ['sharp', 'blurry', 'unsure'] as const
export type GroundTruth = (typeof groundTruths)[number]
// 자동 판정. 아직 결과가 없으면 pending이다.
export type AutomaticVerdict = 'sharp' | 'blurry' | 'unavailable' | 'pending'

export type Outcome =
  | 'true-positive' // 흐림을 흐림으로
  | 'true-negative' // 선명을 선명으로
  | 'false-positive' // 오탐: 선명을 흐림으로
  | 'false-negative' // 미탐: 흐림을 선명으로
  | 'unavailable' // 정답이 있지만 판정하지 못함
  | 'pending' // 정답이 있지만 아직 분석 중
  | 'unsure' // 판단 보류 라벨
  | 'unlabeled' // 정답 없음

export interface EvaluationRow {
  readonly label: GroundTruth | null
  readonly verdict: AutomaticVerdict
}

// 비율과 Wilson 95% 신뢰구간. 분모가 0이면 값과 구간은 null(계산 불가)이다.
export interface Proportion {
  readonly numerator: number
  readonly denominator: number
  readonly value: number | null
  readonly interval: { readonly low: number; readonly high: number } | null
}

export interface EvaluationSummary {
  readonly total: number
  readonly unlabeled: number
  readonly unsure: number
  // 정답(선명·흐림)이 있지만 아직 분석 중인 사진. 통계에 넣지 않으므로 0이 아니면 결과가 미완성이다.
  readonly pending: number
  // 정답(선명·흐림)이 있고 분석이 끝난 사진 = 통계의 전체 분모
  readonly labeled: { readonly total: number; readonly sharp: number; readonly blurry: number }
  readonly counts: {
    readonly truePositive: number
    readonly trueNegative: number
    readonly falsePositive: number
    readonly falseNegative: number
    readonly unavailableSharp: number
    readonly unavailableBlurry: number
  }
  // 판정 가능 비율: 정답 있는 사진 중 선명·흐림으로 판정한 비율
  readonly coverage: { readonly all: Proportion; readonly sharp: Proportion; readonly blurry: Proportion }
  // 판정한 사진만 대상으로 한 성능. 반드시 coverage와 함께 본다.
  readonly judged: {
    readonly accuracy: Proportion
    readonly precision: Proportion
    readonly recall: Proportion
    readonly falsePositiveRate: Proportion
  }
  // 분석 불가를 분모에 포함한 전체 기준 성능. 분석 불가는 맞힌 것으로 보지 않는다.
  readonly overall: {
    // (정상 판정) / 정답 있는 전체
    readonly accuracy: Proportion
    // 흐린 사진 중 흐림 의심으로 표시된 비율(분석 불가는 놓친 것)
    readonly recall: Proportion
    // 선명한 사진 중 흐림 의심으로 잘못 표시된 비율
    readonly falsePositiveRate: Proportion
  }
  // 어느 한쪽 정답의 표본이 MIN_RELIABLE_CLASS_SIZE 미만이면 참고용이다.
  readonly smallSample: boolean
}

// 정답별 표본이 이 수보다 적으면 비율의 신뢰구간이 넓어 통계를 참고용으로 표시한다.
export const MIN_RELIABLE_CLASS_SIZE = 30
const Z_95 = 1.959964

export function classifyOutcome({ label, verdict }: EvaluationRow): Outcome {
  if (label === null) return 'unlabeled'
  if (label === 'unsure') return 'unsure'
  if (verdict === 'pending') return 'pending'
  if (verdict === 'unavailable') return 'unavailable'
  if (label === 'blurry') return verdict === 'blurry' ? 'true-positive' : 'false-negative'
  return verdict === 'sharp' ? 'true-negative' : 'false-positive'
}

// Wilson 점수 구간. 표본이 작거나 비율이 0·1에 가까워도 0~1 밖으로 나가지 않는다.
export function proportion(numerator: number, denominator: number): Proportion {
  if (denominator === 0) return { numerator, denominator, value: null, interval: null }
  const p = numerator / denominator
  const z2 = Z_95 * Z_95
  const scale = 1 + z2 / denominator
  const center = (p + z2 / (2 * denominator)) / scale
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) / scale
  return {
    numerator,
    denominator,
    value: p,
    interval: { low: Math.max(0, center - half), high: Math.min(1, center + half) },
  }
}

export function summarizeEvaluation(rows: readonly EvaluationRow[]): EvaluationSummary {
  const tally: Record<Outcome, number> = {
    'true-positive': 0,
    'true-negative': 0,
    'false-positive': 0,
    'false-negative': 0,
    unavailable: 0,
    pending: 0,
    unsure: 0,
    unlabeled: 0,
  }
  let unavailableSharp = 0
  let unavailableBlurry = 0
  for (const row of rows) {
    const outcome = classifyOutcome(row)
    tally[outcome] += 1
    if (outcome === 'unavailable') {
      if (row.label === 'sharp') unavailableSharp += 1
      else unavailableBlurry += 1
    }
  }

  const tp = tally['true-positive']
  const tn = tally['true-negative']
  const fp = tally['false-positive']
  const fn = tally['false-negative']
  const sharp = tn + fp + unavailableSharp
  const blurry = tp + fn + unavailableBlurry
  const judged = tp + tn + fp + fn

  return {
    total: rows.length,
    unlabeled: tally.unlabeled,
    unsure: tally.unsure,
    pending: tally.pending,
    labeled: { total: sharp + blurry, sharp, blurry },
    counts: { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn, unavailableSharp, unavailableBlurry },
    coverage: {
      all: proportion(judged, sharp + blurry),
      sharp: proportion(tn + fp, sharp),
      blurry: proportion(tp + fn, blurry),
    },
    judged: {
      accuracy: proportion(tp + tn, judged),
      precision: proportion(tp, tp + fp),
      recall: proportion(tp, tp + fn),
      falsePositiveRate: proportion(fp, fp + tn),
    },
    overall: {
      accuracy: proportion(tp + tn, sharp + blurry),
      recall: proportion(tp, blurry),
      falsePositiveRate: proportion(fp, sharp),
    },
    smallSample: sharp < MIN_RELIABLE_CLASS_SIZE || blurry < MIN_RELIABLE_CLASS_SIZE,
  }
}
