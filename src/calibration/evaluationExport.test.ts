import { describe, expect, it } from 'vitest'
import {
  DEFOCUS_MAX_SPREAD,
  DEFOCUS_MIN_REGIONS,
  DEFOCUS_PAIR_SPREAD,
  SHAKE_COARSE_GRID,
  SHAKE_ISOTROPIC_LIMIT,
  SHAKE_MIN_COARSE_BALANCE,
  SHAKE_MIN_REGIONS,
  SHAKE_MIN_SPREAD,
  SHAKE_SCALE_LOSS,
  SHARPNESS_CLASSIFIER_REVISION,
  SHARPNESS_HALF_SCALE_FACTOR,
  SHARP_RATIO_THRESHOLD,
} from '../photos/sharpness.ts'
import {
  EVALUATION_FORMAT,
  bitsPerPixel,
  buildEvaluationCsv,
  buildEvaluationJson,
  type EvaluationEnvironment,
  type EvaluationPhoto,
} from './evaluationExport.ts'
import { createMeasurement } from '../test/measurements.ts'

const photo = (change: Partial<EvaluationPhoto> = {}): EvaluationPhoto => ({
  id: 'photo-1',
  label: 'sharp',
  condition: 'outdoor',
  sceneGroup: 3,
  origin: 'real-capture',
  reviewed: true,
  verdict: 'sharp',
  unavailableReason: null,
  measurement: createMeasurement({ score: 0.0412, hasUnjudgedDirection: false, noise: 0.37, directionScores: [0.0412, 0.05, 0.07, 0.08] }),
  format: 'jpeg',
  width: 4032,
  height: 3024,
  bitsPerPixel: 2.5,
  ...change,
})

const environment: EvaluationEnvironment = { device: 'Pixel 7 기본 카메라', analysisPath: 'worker', userAgent: null }
const exportedAt = new Date('2026-10-30T01:02:03Z')

describe('evaluation export', () => {
  it('writes the settings, environment, summary and per-photo measurements as JSON', () => {
    const report = JSON.parse(
      buildEvaluationJson(
        [
          photo(),
          photo({ id: 'photo-2', label: 'blurry', verdict: 'sharp' }),
          photo({ id: 'photo-3', label: null, verdict: 'unavailable', unavailableReason: 'low-detail', measurement: null }),
        ],
        environment,
        exportedAt,
      ),
    )
    expect(report.format).toBe(EVALUATION_FORMAT)
    expect(report.version).toBe(5)
    expect(report.settings.halfScaleFactor).toBe(SHARPNESS_HALF_SCALE_FACTOR)
    expect(report.exportedAt).toBe('2026-10-30T01:02:03.000Z')
    expect(report.settings.sharpRatioThreshold).toBe(SHARP_RATIO_THRESHOLD)
    // 같은 임계값이라도 판정 규칙이 다르면 결과를 비교할 수 없으므로 규칙의 판과 흔들림·초점 불량 기준을 함께 기록한다.
    expect(report.settings.classifierRevision).toBe(SHARPNESS_CLASSIFIER_REVISION)
    expect(report.settings.shake).toEqual({
      coarseGrid: SHAKE_COARSE_GRID,
      minCoarseBalance: SHAKE_MIN_COARSE_BALANCE,
      scaleLoss: SHAKE_SCALE_LOSS,
      minRegions: SHAKE_MIN_REGIONS,
      minSpread: SHAKE_MIN_SPREAD,
      isotropicLimit: SHAKE_ISOTROPIC_LIMIT,
    })
    expect(report.settings.defocus).toEqual({ pairSpread: DEFOCUS_PAIR_SPREAD, maxSpread: DEFOCUS_MAX_SPREAD, minRegions: DEFOCUS_MIN_REGIONS })
    expect(report.environment).toEqual(environment)
    expect(report.summary.counts.falseNegative).toBe(1)
    expect(report.photos[0]).toEqual({
      id: 'photo-1',
      label: 'sharp',
      condition: 'outdoor',
      sceneGroup: 3,
      origin: 'real-capture',
      reviewed: true,
      verdict: 'sharp',
      outcome: 'true-negative',
      unavailableReason: null,
      score: 0.0412,
      noise: 0.37,
      hasUnjudgedDirection: false,
      directionScores: [0.0412, 0.05, 0.07, 0.08],
      halfScale: null,
      format: 'jpeg',
      width: 4032,
      height: 3024,
      bitsPerPixel: 2.5,
    })
    expect(report.photos[1].outcome).toBe('false-negative')
    expect(report.photos[2]).toMatchObject({ outcome: 'unlabeled', score: null, unavailableReason: 'low-detail' })
  })

  it('only has fields that cannot identify the file, its location or its metadata', () => {
    const report = JSON.parse(buildEvaluationJson([photo()], environment, exportedAt))
    expect(Object.keys(report.photos[0]).sort()).toEqual(
      [
        'bitsPerPixel',
        'condition',
        'directionScores',
        'format',
        'height',
        'halfScale',
        'hasUnjudgedDirection',
        'id',
        'label',
        'noise',
        'origin',
        'outcome',
        'reviewed',
        'sceneGroup',
        'score',
        'unavailableReason',
        'verdict',
        'width',
      ].sort(),
    )
    expect(Object.keys(report).sort()).toEqual(
      ['environment', 'exportedAt', 'format', 'photos', 'settings', 'summary', 'version'].sort(),
    )
  })

  it('includes the browser User-Agent only when the user chose to', () => {
    const without = buildEvaluationJson([photo()], environment, exportedAt)
    expect(JSON.parse(without).environment.userAgent).toBeNull()
    const withAgent = { ...environment, userAgent: 'Mozilla/5.0 Test' }
    expect(JSON.parse(buildEvaluationJson([photo()], withAgent, exportedAt)).environment.userAgent).toBe('Mozilla/5.0 Test')
    expect(buildEvaluationCsv([photo()], withAgent)).toContain('Mozilla/5.0 Test')
    expect(buildEvaluationCsv([photo()], environment)).not.toContain('Mozilla')
  })

  it('writes CSV with a header, CRLF rows, empty cells for missing values and escaped text', () => {
    const csv = buildEvaluationCsv(
      [photo(), photo({ id: 'photo-2', label: null, measurement: null, verdict: 'pending', condition: null, sceneGroup: null, origin: null, reviewed: false })],
      { ...environment, device: '=HYPERLINK("x"), "따옴표"' },
    )
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(
      'id,label,condition,sceneGroup,origin,reviewed,verdict,outcome,unavailableReason,score,noise,hasUnjudgedDirection,format,width,height,bitsPerPixel,device,analysisPath,userAgent,directionScoreHorizontal,directionScoreVertical,directionScoreDiagonalDown,directionScoreDiagonalUp,halfScaleScore,halfScaleNoise',
    )
    expect(lines[1]).toBe(
      'photo-1,sharp,outdoor,3,real-capture,true,sharp,true-negative,,0.0412,0.37,false,jpeg,4032,3024,2.5,"\'=HYPERLINK(""x""), ""따옴표""",worker,,0.0412,0.05,0.07,0.08,,',
    )
    expect(lines[2]).toMatch(/^photo-2,,,,,false,pending,unlabeled,,,,,jpeg,/)
    expect(lines.at(-1)).toBe('')
  })

  it('preserves unjudged directions separately from absent measurements without rounding scores', () => {
    const photos = [
      photo({
        verdict: 'unavailable', unavailableReason: 'low-detail',
        measurement: createMeasurement({ score: 0.04123456789, hasUnjudgedDirection: true, directionScores: [null, 0.04123456789, 0.1, null] }),
      }),
      photo({
        verdict: 'unavailable', unavailableReason: 'low-detail',
        measurement: createMeasurement(),
      }),
      ...(['too-small', 'failed', 'unsupported', 'timeout'] as const).map((reason) =>
        photo({ verdict: 'unavailable', unavailableReason: reason, measurement: null }),
      ),
      photo({ verdict: 'pending', measurement: null }),
    ]
    const report = JSON.parse(buildEvaluationJson(photos, environment, exportedAt))
    expect(report.photos.map((row: { directionScores: unknown }) => row.directionScores)).toEqual([
      [null, 0.04123456789, 0.1, null], [null, null, null, null], null, null, null, null, null,
    ])
    expect(report.photos[0]).toMatchObject({ verdict: 'unavailable', unavailableReason: 'low-detail', hasUnjudgedDirection: true, score: 0.04123456789 })
    const csvRows = buildEvaluationCsv(photos, environment).trimEnd().split('\r\n').slice(1)
    expect(csvRows[0]!.split(',').slice(-6, -2)).toEqual(['', '0.04123456789', '0.1', ''])
    for (const row of csvRows.slice(1)) expect(row.split(',').slice(-6, -2)).toEqual(['', '', '', ''])
  })

  it('exports the half-scale measurement of an undecidable photo separately from the analysis-size values', () => {
    const halfScale = createMeasurement({ score: 0.012, noise: 0.31, directionScores: [0.012, 0.013, null, null] })
    const measurement = createMeasurement({ score: null, noise: 0.62, hasUnjudgedDirection: true, halfScale })
    const report = JSON.parse(buildEvaluationJson([photo({ verdict: 'blurry', measurement })], environment, exportedAt))
    expect(report.photos[0]).toMatchObject({
      score: null,
      noise: 0.62,
      halfScale: { score: 0.012, noise: 0.31, hasUnjudgedDirection: false, directionScores: [0.012, 0.013, null, null] },
    })
    const csvRow = buildEvaluationCsv([photo({ verdict: 'blurry', measurement })], environment).split('\r\n')[1]!
    expect(csvRow.split(',').slice(-2)).toEqual(['0.012', '0.31'])
  })

  it('computes bits per pixel as a rough compression level', () => {
    expect(bitsPerPixel(1_500_000, 4000, 3000)).toBe(1)
    expect(bitsPerPixel(1000, 0, 0)).toBe(0)
  })
})
