import { describe, expect, it } from 'vitest'
import { SHARP_RATIO_THRESHOLD } from '../photos/sharpness.ts'
import {
  EVALUATION_FORMAT,
  bitsPerPixel,
  buildEvaluationCsv,
  buildEvaluationJson,
  type EvaluationEnvironment,
  type EvaluationPhoto,
} from './evaluationExport.ts'

const photo = (change: Partial<EvaluationPhoto> = {}): EvaluationPhoto => ({
  id: 'photo-1',
  label: 'sharp',
  condition: 'outdoor',
  sceneGroup: 3,
  origin: 'real-capture',
  reviewed: true,
  verdict: 'sharp',
  unavailableReason: null,
  measurement: { score: 0.0412, hasUnjudgedDirection: false, noise: 0.37 },
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
    expect(report.version).toBe(2)
    expect(report.exportedAt).toBe('2026-10-30T01:02:03.000Z')
    expect(report.settings.sharpRatioThreshold).toBe(SHARP_RATIO_THRESHOLD)
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
        'format',
        'height',
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
      'id,label,condition,sceneGroup,origin,reviewed,verdict,outcome,unavailableReason,score,noise,hasUnjudgedDirection,format,width,height,bitsPerPixel,device,analysisPath,userAgent',
    )
    expect(lines[1]).toBe(
      'photo-1,sharp,outdoor,3,real-capture,true,sharp,true-negative,,0.0412,0.37,false,jpeg,4032,3024,2.5,"\'=HYPERLINK(""x""), ""따옴표""",worker,',
    )
    expect(lines[2]).toMatch(/^photo-2,,,,,false,pending,unlabeled,,,,,jpeg,/)
    expect(lines.at(-1)).toBe('')
  })

  it('computes bits per pixel as a rough compression level', () => {
    expect(bitsPerPixel(1_500_000, 4000, 3000)).toBe(1)
    expect(bitsPerPixel(1000, 0, 0)).toBe(0)
  })
})
