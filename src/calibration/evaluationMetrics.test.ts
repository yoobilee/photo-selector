import { describe, expect, it } from 'vitest'
import {
  MIN_RELIABLE_CLASS_SIZE,
  classifyOutcome,
  proportion,
  summarizeEvaluation,
  type AutomaticVerdict,
  type EvaluationRow,
  type GroundTruth,
} from './evaluationMetrics.ts'

const rows = (label: GroundTruth | null, verdict: AutomaticVerdict, count: number): EvaluationRow[] =>
  Array.from({ length: count }, () => ({ label, verdict }))

describe('classifyOutcome', () => {
  it('treats blurry as the positive class', () => {
    expect(classifyOutcome({ label: 'blurry', verdict: 'blurry' })).toBe('true-positive')
    expect(classifyOutcome({ label: 'sharp', verdict: 'sharp' })).toBe('true-negative')
    expect(classifyOutcome({ label: 'sharp', verdict: 'blurry' })).toBe('false-positive')
    expect(classifyOutcome({ label: 'blurry', verdict: 'sharp' })).toBe('false-negative')
  })

  it('keeps unavailable, pending, unsure and unlabeled apart from right and wrong', () => {
    expect(classifyOutcome({ label: 'sharp', verdict: 'unavailable' })).toBe('unavailable')
    expect(classifyOutcome({ label: 'blurry', verdict: 'pending' })).toBe('pending')
    expect(classifyOutcome({ label: 'unsure', verdict: 'blurry' })).toBe('unsure')
    expect(classifyOutcome({ label: null, verdict: 'blurry' })).toBe('unlabeled')
  })
})

describe('proportion', () => {
  it('returns null when there is nothing to divide', () => {
    expect(proportion(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null, interval: null })
  })

  it('computes the Wilson 95% interval and keeps it inside 0..1', () => {
    const half = proportion(5, 10)
    expect(half.value).toBe(0.5)
    expect(half.interval!.low).toBeCloseTo(0.2366, 3)
    expect(half.interval!.high).toBeCloseTo(0.7634, 3)
    const none = proportion(0, 4)
    expect(none.interval!.low).toBe(0)
    expect(none.interval!.high).toBeCloseTo(0.4899, 3)
    const all = proportion(4, 4)
    expect(all.interval!.high).toBeCloseTo(1, 12)
    expect(all.interval!.low).toBeCloseTo(0.5101, 3)
  })

  it('narrows the interval as the sample grows', () => {
    const small = proportion(9, 10).interval!
    const large = proportion(90, 100).interval!
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })
})

describe('summarizeEvaluation', () => {
  // 선명 10장(정상 7, 오탐 1, 분석 불가 2), 흐림 10장(정상 6, 미탐 2, 분석 불가 2), 판단 보류 3장, 정답 없음 4장, 분석 중 1장
  const sample = [
    ...rows('sharp', 'sharp', 7),
    ...rows('sharp', 'blurry', 1),
    ...rows('sharp', 'unavailable', 2),
    ...rows('blurry', 'blurry', 6),
    ...rows('blurry', 'sharp', 2),
    ...rows('blurry', 'unavailable', 2),
    ...rows('unsure', 'blurry', 2),
    ...rows('unsure', 'unavailable', 1),
    ...rows(null, 'sharp', 4),
    ...rows('blurry', 'pending', 1),
  ]
  const summary = summarizeEvaluation(sample)

  it('counts each outcome and excludes unlabeled, unsure and pending photos from the statistics', () => {
    expect(summary.total).toBe(28)
    expect(summary.unlabeled).toBe(4)
    expect(summary.unsure).toBe(3)
    expect(summary.pending).toBe(1)
    expect(summary.labeled).toEqual({ total: 20, sharp: 10, blurry: 10 })
    expect(summary.counts).toEqual({
      truePositive: 6,
      trueNegative: 7,
      falsePositive: 1,
      falseNegative: 2,
      unavailableSharp: 2,
      unavailableBlurry: 2,
    })
  })

  it('reports judged-only performance together with how many photos could be judged', () => {
    expect(summary.coverage.all).toMatchObject({ numerator: 16, denominator: 20, value: 0.8 })
    expect(summary.coverage.sharp).toMatchObject({ numerator: 8, denominator: 10 })
    expect(summary.coverage.blurry).toMatchObject({ numerator: 8, denominator: 10 })
    expect(summary.judged.accuracy).toMatchObject({ numerator: 13, denominator: 16 })
    expect(summary.judged.precision).toMatchObject({ numerator: 6, denominator: 7 })
    expect(summary.judged.recall).toMatchObject({ numerator: 6, denominator: 8 })
    expect(summary.judged.falsePositiveRate).toMatchObject({ numerator: 1, denominator: 8 })
  })

  it('keeps unavailable photos in the overall denominators instead of dropping them', () => {
    expect(summary.overall.accuracy).toMatchObject({ numerator: 13, denominator: 20, value: 0.65 })
    expect(summary.overall.recall).toMatchObject({ numerator: 6, denominator: 10, value: 0.6 })
    expect(summary.overall.falsePositiveRate).toMatchObject({ numerator: 1, denominator: 10, value: 0.1 })
    // 분석 불가를 빼면 성능이 더 좋아 보인다. 두 값을 함께 보고하는 이유다.
    expect(summary.judged.accuracy.value!).toBeGreaterThan(summary.overall.accuracy.value!)
  })

  it('marks results from small samples as indicative only', () => {
    expect(summary.smallSample).toBe(true)
    const large = summarizeEvaluation([
      ...rows('sharp', 'sharp', MIN_RELIABLE_CLASS_SIZE),
      ...rows('blurry', 'blurry', MIN_RELIABLE_CLASS_SIZE),
    ])
    expect(large.smallSample).toBe(false)
    const oneSided = summarizeEvaluation([...rows('sharp', 'sharp', 100), ...rows('blurry', 'blurry', 5)])
    expect(oneSided.smallSample).toBe(true)
  })

  it('handles an empty evaluation and evaluations without any judged photo', () => {
    const empty = summarizeEvaluation([])
    expect(empty.total).toBe(0)
    expect(empty.labeled.total).toBe(0)
    expect(empty.judged.accuracy.value).toBeNull()
    expect(empty.overall.recall.value).toBeNull()
    expect(empty.smallSample).toBe(true)

    const undecided = summarizeEvaluation([...rows('sharp', 'unavailable', 3), ...rows(null, 'blurry', 2)])
    expect(undecided.coverage.all).toMatchObject({ numerator: 0, denominator: 3, value: 0 })
    expect(undecided.judged.accuracy.value).toBeNull()
    expect(undecided.judged.precision.value).toBeNull()
    expect(undecided.overall.accuracy).toMatchObject({ numerator: 0, denominator: 3, value: 0 })
  })

  it('updates the statistics when a label changes', () => {
    const before = summarizeEvaluation([{ label: 'sharp', verdict: 'blurry' }, { label: 'blurry', verdict: 'blurry' }])
    const after = summarizeEvaluation([{ label: 'blurry', verdict: 'blurry' }, { label: 'blurry', verdict: 'blurry' }])
    expect(before.counts.falsePositive).toBe(1)
    expect(after.counts.falsePositive).toBe(0)
    expect(after.counts.truePositive).toBe(2)
    expect(after.judged.precision.value).toBe(1)
  })
})
