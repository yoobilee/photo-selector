import type { SupportedImageFormat } from '../photos/imageFormat.ts'
import type { SharpnessMeasurement, UnavailableReason } from '../photos/sharpness.ts'
import {
  DEFOCUS_MAX_SPREAD,
  DEFOCUS_MIN_REGIONS,
  DEFOCUS_PAIR_SPREAD,
  NOISE_MARGIN,
  SHAKE_COARSE_GRID,
  SHAKE_ISOTROPIC_LIMIT,
  SHAKE_MIN_COARSE_BALANCE,
  SHAKE_MIN_REGIONS,
  SHAKE_MIN_SPREAD,
  SHAKE_SCALE_LOSS,
  SHARPNESS_CLASSIFIER_REVISION,
  SHARPNESS_ANALYSIS_MAX_EDGE,
  SHARPNESS_COARSE_FACTOR,
  SHARPNESS_GRID,
  SHARPNESS_MIN_EDGE,
  SHARPNESS_TOP_REGIONS,
  SHARP_RATIO_THRESHOLD,
  STRUCTURE_MIN_STRENGTH,
} from '../photos/sharpness.ts'
import type { AnalysisPath } from '../photos/sharpnessWorkerClient.ts'
import { classifyOutcome, summarizeEvaluation, type AutomaticVerdict, type GroundTruth, type Outcome } from './evaluationMetrics.ts'
import type { SampleOrigin } from './groundTruthDataset.ts'

// 내보내기 파일 형식. 파일 이름·경로·EXIF 등 사진을 식별할 수 있는 정보는 넣지 않고 평가용 ID만 쓴다.

export const sceneConditions = [
  'outdoor',
  'indoor',
  'low-light',
  'camera-shake',
  'out-of-focus',
  'portrait-bokeh',
  'landscape-sky',
  'texture',
  'other',
] as const
export type SceneCondition = (typeof sceneConditions)[number]

export interface EvaluationPhoto {
  // 세션 안에서만 의미 있는 평가용 ID. 파일 이름과 무관하다.
  readonly id: string
  readonly label: GroundTruth | null
  readonly condition: SceneCondition | null
  // 같은 장면을 선명·흐림으로 짝지어 찍은 사진에 붙이는 번호
  readonly sceneGroup: number | null
  // 실제 촬영 / 공개 이미지 / 인위적 가공. 실제 사진 성능과 가공 이미지 성능을 나눠 보는 데 쓴다.
  readonly origin: SampleOrigin | null
  // 사람이 정답을 다시 확인했는지
  readonly reviewed: boolean
  readonly verdict: AutomaticVerdict
  readonly unavailableReason: UnavailableReason | null
  readonly measurement: SharpnessMeasurement | null
  readonly format: SupportedImageFormat
  // 표시 기준(EXIF 방향 반영) 원본 크기
  readonly width: number
  readonly height: number
  // 원본 파일 크기 / 화소 수 × 8. 압축 수준을 대략 비교하는 데 쓴다.
  readonly bitsPerPixel: number
}

export interface EvaluationEnvironment {
  // 사용자가 직접 적은 기기·카메라 설명
  readonly device: string
  readonly analysisPath: AnalysisPath
  // 사용자가 포함을 선택했을 때만 넣는다.
  readonly userAgent: string | null
}

export const EVALUATION_FORMAT = 'photo-selector-blur-evaluation'
// 2: 사진별 origin·reviewed 추가
// 3: settings에 판정 규칙의 판(classifierRevision)과 흔들림·초점 불량 기준 추가
// 4: 사진별 방향 점수 추가. 판정 규칙은 바꾸지 않는다.
export const EVALUATION_FORMAT_VERSION = 4

export function bitsPerPixel(byteSize: number, width: number, height: number): number {
  return width > 0 && height > 0 ? Math.round(((byteSize * 8) / (width * height)) * 1000) / 1000 : 0
}

export function buildEvaluationJson(
  photos: readonly EvaluationPhoto[],
  environment: EvaluationEnvironment,
  exportedAt: Date,
): string {
  const report = {
    format: EVALUATION_FORMAT,
    version: EVALUATION_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    // 이 결과를 만든 판정 설정. 판(classifierRevision)이나 설정이 다르면 결과를 직접 비교할 수 없다.
    settings: {
      classifierRevision: SHARPNESS_CLASSIFIER_REVISION,
      sharpRatioThreshold: SHARP_RATIO_THRESHOLD,
      analysisMaxEdge: SHARPNESS_ANALYSIS_MAX_EDGE,
      minEdge: SHARPNESS_MIN_EDGE,
      grid: SHARPNESS_GRID,
      coarseFactor: SHARPNESS_COARSE_FACTOR,
      topRegions: SHARPNESS_TOP_REGIONS,
      structureMinStrength: STRUCTURE_MIN_STRENGTH,
      noiseMargin: NOISE_MARGIN,
      shake: {
        coarseGrid: SHAKE_COARSE_GRID,
        minCoarseBalance: SHAKE_MIN_COARSE_BALANCE,
        scaleLoss: SHAKE_SCALE_LOSS,
        minRegions: SHAKE_MIN_REGIONS,
        minSpread: SHAKE_MIN_SPREAD,
        isotropicLimit: SHAKE_ISOTROPIC_LIMIT,
      },
      defocus: {
        pairSpread: DEFOCUS_PAIR_SPREAD,
        maxSpread: DEFOCUS_MAX_SPREAD,
        minRegions: DEFOCUS_MIN_REGIONS,
      },
    },
    environment,
    summary: summarizeEvaluation(photos),
    photos: photos.map((photo) => ({
      id: photo.id,
      label: photo.label,
      condition: photo.condition,
      sceneGroup: photo.sceneGroup,
      origin: photo.origin,
      reviewed: photo.reviewed,
      verdict: photo.verdict,
      outcome: classifyOutcome(photo),
      unavailableReason: photo.unavailableReason,
      score: photo.measurement?.score ?? null,
      noise: photo.measurement?.noise ?? null,
      hasUnjudgedDirection: photo.measurement?.hasUnjudgedDirection ?? null,
      // 가로, 세로, 대각선↘, 대각선↙. 방향의 null은 판정 불가, 배열 자체의 null은 측정하지 못한 경우다.
      directionScores: photo.measurement?.directionScores ?? null,
      format: photo.format,
      width: photo.width,
      height: photo.height,
      bitsPerPixel: photo.bitsPerPixel,
    })),
  }
  return `${JSON.stringify(report, null, 2)}\n`
}

const csvColumns = [
  'id',
  'label',
  'condition',
  'sceneGroup',
  'origin',
  'reviewed',
  'verdict',
  'outcome',
  'unavailableReason',
  'score',
  'noise',
  'hasUnjudgedDirection',
  'format',
  'width',
  'height',
  'bitsPerPixel',
  'device',
  'analysisPath',
  'userAgent',
  // 기존 열 순서를 유지하고 진단 열을 끝에 추가한다. 측정하지 못했거나 방향을 판정하지 못하면 빈 셀이다.
  'directionScoreHorizontal',
  'directionScoreVertical',
  'directionScoreDiagonalDown',
  'directionScoreDiagonalUp',
] as const

// 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다. 스프레드시트가 수식으로 해석하지 않도록 =,+,-,@로 시작하는 글자 값은 앞에 '를 붙인다.
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return ''
  if (typeof value !== 'string') return String(value)
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function buildEvaluationCsv(photos: readonly EvaluationPhoto[], environment: EvaluationEnvironment): string {
  const rows = photos.map((photo) => {
    const outcome: Outcome = classifyOutcome(photo)
    const values: Record<(typeof csvColumns)[number], string | number | boolean | null> = {
      id: photo.id,
      label: photo.label,
      condition: photo.condition,
      sceneGroup: photo.sceneGroup,
      origin: photo.origin,
      reviewed: photo.reviewed,
      verdict: photo.verdict,
      outcome,
      unavailableReason: photo.unavailableReason,
      score: photo.measurement?.score ?? null,
      noise: photo.measurement?.noise ?? null,
      hasUnjudgedDirection: photo.measurement?.hasUnjudgedDirection ?? null,
      format: photo.format,
      width: photo.width,
      height: photo.height,
      bitsPerPixel: photo.bitsPerPixel,
      device: environment.device,
      analysisPath: environment.analysisPath,
      userAgent: environment.userAgent,
      directionScoreHorizontal: photo.measurement?.directionScores[0] ?? null,
      directionScoreVertical: photo.measurement?.directionScores[1] ?? null,
      directionScoreDiagonalDown: photo.measurement?.directionScores[2] ?? null,
      directionScoreDiagonalUp: photo.measurement?.directionScores[3] ?? null,
    }
    return csvColumns.map((column) => csvCell(values[column])).join(',')
  })
  return `${[csvColumns.join(','), ...rows].join('\r\n')}\r\n`
}
