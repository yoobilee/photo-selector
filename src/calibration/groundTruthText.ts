import {
  GROUND_TRUTH_FORMAT,
  GROUND_TRUTH_FORMAT_VERSION,
  GROUND_TRUTH_HASH_ALGORITHM,
  MAX_GROUND_TRUTH_ENTRIES,
  MAX_GROUND_TRUTH_FILE_BYTES,
  type GroundTruthDatasetStats,
  type GroundTruthExportError,
  type GroundTruthLoadError,
  type SampleOrigin,
} from './groundTruthDataset.ts'
import type { GroundTruthExport, PhotoHash, ResolvedAnnotation } from './groundTruthMatch.ts'

export const sampleOriginText: Record<SampleOrigin, string> = {
  'real-capture': '실제 촬영',
  'public-image': '공개 이미지',
  'synthetic-edit': '인위적 가공',
}

export const groundTruthLoadErrorText: Record<GroundTruthLoadError, string> = {
  'too-large': `파일이 너무 큽니다(최대 ${MAX_GROUND_TRUTH_FILE_BYTES / 1024 / 1024}MB).`,
  unreadable: '파일을 읽지 못했습니다.',
  'invalid-json': 'JSON 형식이 아닙니다. 파일이 잘렸거나 손상되었는지 확인하세요.',
  'not-ground-truth': `정답 데이터 파일이 아닙니다(format이 ${GROUND_TRUTH_FORMAT}이고 entries 목록이 있어야 합니다).`,
  'evaluation-result':
    '평가 결과 파일입니다. 평가 결과에는 세션마다 바뀌는 평가용 ID(photo-N)만 있어 사진과 안전하게 연결할 수 없으므로 정답 데이터로 바꾸지 않습니다. 사진을 불러와 정답을 고른 뒤 "정답 데이터 내보내기"로 만드세요.',
  'unsupported-version': `지원하지 않는 정답 데이터 버전입니다(지원: ${GROUND_TRUTH_FORMAT_VERSION}).`,
  'unsupported-hash': `지원하지 않는 해시 방식입니다(지원: ${GROUND_TRUTH_HASH_ALGORITHM}).`,
  'too-many-entries': `항목이 너무 많습니다(최대 ${MAX_GROUND_TRUTH_ENTRIES.toLocaleString('ko-KR')}개).`,
}

export const groundTruthExportErrorText: Record<GroundTruthExportError, string> = {
  'too-many-entries': `항목이 불러오기 한도(최대 ${MAX_GROUND_TRUTH_ENTRIES.toLocaleString('ko-KR')}개)를 넘어 다시 불러올 수 없습니다.`,
  'too-large': `파일 크기가 불러오기 한도(최대 ${MAX_GROUND_TRUTH_FILE_BYTES / 1024 / 1024}MB)를 넘어 다시 불러올 수 없습니다. 출처·가공 설명을 줄여 보세요.`,
}

const joinNonZero =(parts: readonly [number, string][]) =>
  parts
    .filter(([count]) => count > 0)
    .map(([count, text]) => `${text} ${count}`)
    .join(', ')

export function describeGroundTruthLoaded({ usable, invalid, duplicate, conflicting }: GroundTruthDatasetStats): string {
  const problems = joinNonZero([
    [invalid, '손상'],
    [duplicate, '중복'],
    [conflicting, '충돌'],
  ])
  const base = `정답 데이터를 불러왔습니다. 사진에 적용할 수 있는 항목 ${usable}개.`
  return problems ? `${base} 적용하지 않은 항목: ${problems}.` : base
}

export function describeGroundTruthExport(result: GroundTruthExport): string {
  const skipped = joinNonZero([
    [result.skippedUnlabeled, '정답 미지정 사진'],
    [result.skippedNoHash, '해시가 없는(계산 중·실패) 사진'],
    [result.droppedConflicts, '정답 데이터 안에서 충돌한 해시'],
  ])
  const suffix = skipped ? ` 넣지 않음: ${skipped}.` : ''
  if (result.entries.length === 0) return `내보낼 정답이 없습니다. 사진에 정답을 고른 뒤 다시 내보내세요.${suffix}`
  return `정답 데이터 ${result.entries.length}개를 내보냈습니다(지금 사진 ${result.fromPhotos}개, 불러온 정답 데이터에서 유지 ${result.preserved}개).${suffix}`
}

export interface GroundTruthStatus {
  readonly text: string
  // 정답 데이터를 적용하지 못했거나 직접 고른 정답과 달라 확인이 필요한 상태
  readonly needsAttention: boolean
}

// 표의 사진별 정답 데이터 연결 상태. 정답 데이터를 불러오지 않았으면 해시 계산 실패만 알린다(정답 데이터 내보내기에서 빠진다).
export function describeGroundTruthStatus(hash: PhotoHash | undefined, resolved: ResolvedAnnotation): GroundTruthStatus | null {
  const { link } = resolved
  if (!link) return hash?.status === 'failed' ? { text: '해시 계산 실패 — 정답 데이터에 넣을 수 없음', needsAttention: true } : null
  switch (link.kind) {
    case 'matched':
      if (resolved.differsFromDataset) return { text: '직접 고른 정답 유지(정답 데이터와 다름)', needsAttention: true }
      return { text: resolved.source === 'dataset' ? '정답 데이터에서 적용' : '직접 고른 정답이 정답 데이터와 같음', needsAttention: false }
    case 'not-in-dataset':
      return { text: '정답 데이터에 없음', needsAttention: false }
    case 'conflicting':
      return { text: '정답 데이터 안에서 충돌 — 적용 안 함', needsAttention: true }
    case 'hash-pending':
      return { text: '해시 계산 중', needsAttention: false }
    case 'hash-failed':
      return { text: '해시 계산 실패 — 정답 데이터와 연결 불가', needsAttention: true }
  }
}
