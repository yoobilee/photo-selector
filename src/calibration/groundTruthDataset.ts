import { EVALUATION_FORMAT, sceneConditions, type SceneCondition } from './evaluationExport.ts'
import { groundTruths, type GroundTruth } from './evaluationMetrics.ts'

// 사람이 미리 정한 사진별 정답 데이터의 형식. React·DOM에 의존하지 않는 순수 함수다.
// 사진은 원본 파일 바이트의 SHA-256으로 찾는다. 세션마다 바뀌는 평가용 ID(photo-N)와 파일 이름·경로·EXIF는 쓰지 않는다.
// 정답은 사람이 정한 값만 담는다. 자동 판정 결과(판정·점수)는 넣지 않으며 판정에 맞춰 바꾸지 않는다.
// 다른 사람에게 받은 파일일 수 있으므로 JSON.parse로 값만 읽고, 아는 필드만 형식을 검사해 새 객체로 옮긴다(코드로 실행하지 않는다).

export const GROUND_TRUTH_FORMAT = 'photo-selector-blur-ground-truth'
export const GROUND_TRUTH_FORMAT_VERSION = 1
export const GROUND_TRUTH_HASH_ALGORITHM = 'SHA-256'
export const MAX_GROUND_TRUTH_FILE_BYTES = 5 * 1024 * 1024
export const MAX_GROUND_TRUTH_ENTRIES = 20_000
// 출처·가공 방식 설명의 최대 길이
export const MAX_NOTE_LENGTH = 300
// 화면에 번호를 보여 줄 손상 항목 수
const MAX_REPORTED_INVALID_ENTRIES = 5
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

// 해시도 파일을 가리키는 식별 정보라는 안내. 내보낸 파일 안에도 넣어 파일만 받은 사람도 볼 수 있게 한다.
export const GROUND_TRUTH_NOTICE =
  '각 항목의 sha256은 원본 사진 파일의 내용으로 계산한 값입니다. 같은 파일을 가진 사람은 이 데이터와 사진을 연결할 수 있으므로 공유할 때 주의하세요.'

export const sampleOrigins = ['real-capture', 'public-image', 'synthetic-edit'] as const
export type SampleOrigin = (typeof sampleOrigins)[number]

// 사진 한 장에 사람이 붙인 정답과 설명
export interface PhotoAnnotation {
  readonly label: GroundTruth | null
  readonly condition: SceneCondition | null
  // 같은 장면을 선명·흐림으로 짝지어 찍은 사진에 붙이는 번호
  readonly sceneGroup: number | null
  // 실제 촬영 / 공개 이미지 / 인위적 가공
  readonly origin: SampleOrigin | null
  // 원본 출처(공개 이미지의 주소·라이선스 등). 정답 데이터에만 두고 평가 결과에는 넣지 않는다.
  readonly sourceNote: string | null
  // 인위적 가공 방식(예: 가우시안 흐림 σ=3). 정답 데이터에만 둔다.
  readonly processing: string | null
  // 사람이 정답을 다시 확인했는지
  readonly reviewed: boolean
}

export const EMPTY_ANNOTATION: PhotoAnnotation = {
  label: null,
  condition: null,
  sceneGroup: null,
  origin: null,
  sourceNote: null,
  processing: null,
  reviewed: false,
}

// 정답 데이터의 항목. 정답(label)이 없는 항목은 두지 않는다.
export interface GroundTruthEntry extends PhotoAnnotation {
  // 원본 파일 바이트의 SHA-256(소문자 16진수)
  readonly sha256: string
  readonly label: GroundTruth
}

export interface GroundTruthDatasetStats {
  readonly total: number
  // 사진에 적용할 수 있는 항목(해시 기준 1개씩)
  readonly usable: number
  // 형식이 틀려 버린 항목
  readonly invalid: number
  // 같은 해시·같은 내용이 반복된 항목. 하나만 쓴다.
  readonly duplicate: number
  // 같은 해시에 서로 다른 내용이 있는 해시 수. 어느 쪽도 적용하지 않는다.
  readonly conflicting: number
  // 손상 항목의 순번(1부터, 앞의 몇 개만)
  readonly invalidEntryNumbers: readonly number[]
}

export interface GroundTruthDataset {
  // 해시 → 적용할 항목
  readonly entries: ReadonlyMap<string, GroundTruthEntry>
  readonly conflictingHashes: ReadonlySet<string>
  readonly stats: GroundTruthDatasetStats
}

export type GroundTruthParseError =
  | 'invalid-json'
  | 'not-ground-truth'
  // 평가 결과 파일(photo-N만 있어 사진과 연결할 수 없다)
  | 'evaluation-result'
  | 'unsupported-version'
  | 'unsupported-hash'
  | 'too-many-entries'

export type GroundTruthParseResult =
  | { readonly ok: true; readonly dataset: GroundTruthDataset }
  | { readonly ok: false; readonly error: GroundTruthParseError }

// 파일 읽기 단계의 실패까지 포함한 불러오기 실패 이유
export type GroundTruthLoadError = 'too-large' | 'unreadable' | GroundTruthParseError
export type GroundTruthLoadResult =
  | { readonly ok: true; readonly dataset: GroundTruthDataset }
  | { readonly ok: false; readonly error: GroundTruthLoadError }

const INVALID = Symbol('invalid')
type Read<T> = T | typeof INVALID

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// 값이 없거나 null이면 fallback을 쓴다.
const optional = <T>(value: unknown, fallback: T, read: (value: unknown) => Read<T>): Read<T> =>
  value === undefined || value === null ? fallback : read(value)

const oneOf =
  <T extends string>(options: readonly T[]) =>
  (value: unknown): Read<T> =>
    typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : INVALID

const readPositiveInteger = (value: unknown): Read<number> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : INVALID

const readBoolean = (value: unknown): Read<boolean> => (typeof value === 'boolean' ? value : INVALID)

// 앞뒤 공백을 지우고, 빈 글자는 값 없음으로 본다. 너무 길면 자르지 않고 손상 항목으로 본다.
const readNote = (value: unknown): Read<string | null> => {
  if (typeof value !== 'string') return INVALID
  const trimmed = value.trim()
  if (trimmed.length > MAX_NOTE_LENGTH) return INVALID
  return trimmed === '' ? null : trimmed
}

function readEntry(value: unknown): GroundTruthEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) return null
  const label = oneOf(groundTruths)(value.label)
  const condition = optional(value.condition, null, oneOf(sceneConditions))
  const sceneGroup = optional(value.sceneGroup, null, readPositiveInteger)
  const origin = optional(value.origin, null, oneOf(sampleOrigins))
  const sourceNote = optional(value.sourceNote, null, readNote)
  const processing = optional(value.processing, null, readNote)
  const reviewed = optional(value.reviewed, false, readBoolean)
  if (
    label === INVALID ||
    condition === INVALID ||
    sceneGroup === INVALID ||
    origin === INVALID ||
    sourceNote === INVALID ||
    processing === INVALID ||
    reviewed === INVALID
  ) {
    return null
  }
  return { sha256: value.sha256.toLowerCase(), label, condition, sceneGroup, origin, sourceNote, processing, reviewed }
}

export function sameAnnotation(first: PhotoAnnotation, second: PhotoAnnotation): boolean {
  return (
    first.label === second.label &&
    first.condition === second.condition &&
    first.sceneGroup === second.sceneGroup &&
    first.origin === second.origin &&
    first.sourceNote === second.sourceNote &&
    first.processing === second.processing &&
    first.reviewed === second.reviewed
  )
}

// 정답 데이터 글자를 검사해 읽는다. 파일 구조가 틀리면 전체를 거부하고, 항목 하나가 틀리면 그 항목만 버리고 건수를 남긴다.
export function parseGroundTruthDataset(text: string): GroundTruthParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid-json' }
  }
  if (!isRecord(data)) return { ok: false, error: 'not-ground-truth' }
  if (data.format === EVALUATION_FORMAT) return { ok: false, error: 'evaluation-result' }
  if (data.format !== GROUND_TRUTH_FORMAT) return { ok: false, error: 'not-ground-truth' }
  if (data.version !== GROUND_TRUTH_FORMAT_VERSION) return { ok: false, error: 'unsupported-version' }
  if (data.hashAlgorithm !== GROUND_TRUTH_HASH_ALGORITHM) return { ok: false, error: 'unsupported-hash' }
  if (!Array.isArray(data.entries)) return { ok: false, error: 'not-ground-truth' }
  if (data.entries.length > MAX_GROUND_TRUTH_ENTRIES) return { ok: false, error: 'too-many-entries' }

  const entries = new Map<string, GroundTruthEntry>()
  const conflictingHashes = new Set<string>()
  const invalidEntryNumbers: number[] = []
  let invalid = 0
  let duplicate = 0
  data.entries.forEach((value: unknown, index) => {
    const entry = readEntry(value)
    if (!entry) {
      invalid += 1
      if (invalidEntryNumbers.length < MAX_REPORTED_INVALID_ENTRIES) invalidEntryNumbers.push(index + 1)
      return
    }
    if (conflictingHashes.has(entry.sha256)) return
    const known = entries.get(entry.sha256)
    if (!known) {
      entries.set(entry.sha256, entry)
    } else if (sameAnnotation(known, entry)) {
      duplicate += 1
    } else {
      // 어느 쪽이 맞는지 알 수 없으므로 둘 다 적용하지 않는다.
      entries.delete(entry.sha256)
      conflictingHashes.add(entry.sha256)
    }
  })

  return {
    ok: true,
    dataset: {
      entries,
      conflictingHashes,
      stats: {
        total: data.entries.length,
        usable: entries.size,
        invalid,
        duplicate,
        conflicting: conflictingHashes.size,
        invalidEntryNumbers,
      },
    },
  }
}

// 정답 데이터 파일을 읽어 검사한다. 너무 큰 파일은 읽지 않는다(메인 스레드에서 오래 해석하지 않도록).
export async function readGroundTruthFile(file: Blob): Promise<GroundTruthLoadResult> {
  if (file.size > MAX_GROUND_TRUTH_FILE_BYTES) return { ok: false, error: 'too-large' }
  let text: string
  try {
    text = await file.text()
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  return parseGroundTruthDataset(text)
}

// 불러오기 한도를 넘어 다시 불러올 수 없는 파일은 만들지 않는다.
export type GroundTruthExportError = 'too-many-entries' | 'too-large'
export type GroundTruthJsonResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: GroundTruthExportError }

// 정답 데이터 파일 내용. 항목은 해시 순으로 정렬해 사진을 불러온 순서가 드러나지 않게 한다.
// 항목은 한 줄에 하나씩 써서 사람이 읽을 수 있으면서도 불러오기 크기 한도 안에 들게 한다.
export function buildGroundTruthJson(entries: readonly GroundTruthEntry[], exportedAt: Date): GroundTruthJsonResult {
  if (entries.length > MAX_GROUND_TRUTH_ENTRIES) return { ok: false, error: 'too-many-entries' }
  const sorted = [...entries].sort((first, second) => (first.sha256 < second.sha256 ? -1 : first.sha256 > second.sha256 ? 1 : 0))
  const header = {
    format: GROUND_TRUTH_FORMAT,
    version: GROUND_TRUTH_FORMAT_VERSION,
    hashAlgorithm: GROUND_TRUTH_HASH_ALGORITHM,
    exportedAt: exportedAt.toISOString(),
    notice: GROUND_TRUTH_NOTICE,
  }
  const entryLines = sorted.map((entry) =>
    JSON.stringify({
      sha256: entry.sha256,
      label: entry.label,
      condition: entry.condition,
      sceneGroup: entry.sceneGroup,
      origin: entry.origin,
      reviewed: entry.reviewed,
      processing: entry.processing,
      sourceNote: entry.sourceNote,
    }),
  )
  const lines = [
    '{',
    ...Object.entries(header).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`),
    entryLines.length === 0 ? '  "entries": []' : `  "entries": [\n    ${entryLines.join(',\n    ')}\n  ]`,
    '}',
  ]
  const text = `${lines.join('\n')}\n`
  if (new TextEncoder().encode(text).byteLength > MAX_GROUND_TRUTH_FILE_BYTES) return { ok: false, error: 'too-large' }
  return { ok: true, text }
}
