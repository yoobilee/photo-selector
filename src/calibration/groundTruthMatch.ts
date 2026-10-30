import {
  EMPTY_ANNOTATION,
  sameAnnotation,
  type GroundTruthDataset,
  type GroundTruthEntry,
  type PhotoAnnotation,
} from './groundTruthDataset.ts'

// 불러온 사진과 정답 데이터를 원본 바이트 해시로 연결한다. React·DOM에 의존하지 않는 순수 함수다.
// 사람이 직접 고른 정답은 정답 데이터로 덮어쓰지 않는다. 확실히 연결된 사진(해시 일치, 데이터 안 충돌 없음)에만 적용한다.

// 사진의 원본 바이트 해시. 계산 중이면 아직 값이 없다.
export type PhotoHash = { readonly status: 'ready'; readonly sha256: string } | { readonly status: 'failed' }

export type GroundTruthLink =
  | { readonly kind: 'hash-pending' }
  | { readonly kind: 'hash-failed' }
  | { readonly kind: 'not-in-dataset' }
  // 정답 데이터 안에서 같은 해시에 다른 정답이 있어 적용하지 않음
  | { readonly kind: 'conflicting' }
  | { readonly kind: 'matched'; readonly entry: GroundTruthEntry }

export function linkGroundTruth(hash: PhotoHash | undefined, dataset: GroundTruthDataset): GroundTruthLink {
  if (!hash) return { kind: 'hash-pending' }
  if (hash.status === 'failed') return { kind: 'hash-failed' }
  if (dataset.conflictingHashes.has(hash.sha256)) return { kind: 'conflicting' }
  const entry = dataset.entries.get(hash.sha256)
  return entry ? { kind: 'matched', entry } : { kind: 'not-in-dataset' }
}

export function toAnnotation({ label, condition, sceneGroup, origin, sourceNote, processing, reviewed }: GroundTruthEntry): PhotoAnnotation {
  return { label, condition, sceneGroup, origin, sourceNote, processing, reviewed }
}

export interface ResolvedAnnotation {
  readonly annotation: PhotoAnnotation
  // 화면에 쓰는 정답이 어디서 왔는지
  readonly source: 'none' | 'manual' | 'dataset'
  // 정답 데이터를 불러오지 않았으면 null
  readonly link: GroundTruthLink | null
  // 직접 고른 정답이 연결된 정답 데이터와 다른지(직접 고른 쪽을 쓴다)
  readonly differsFromDataset: boolean
}

export function resolveAnnotation(manual: PhotoAnnotation | undefined, link: GroundTruthLink | null): ResolvedAnnotation {
  const fromDataset = link?.kind === 'matched' ? toAnnotation(link.entry) : null
  if (manual) {
    return { annotation: manual, source: 'manual', link, differsFromDataset: fromDataset !== null && !sameAnnotation(manual, fromDataset) }
  }
  if (fromDataset) return { annotation: fromDataset, source: 'dataset', link, differsFromDataset: false }
  return { annotation: EMPTY_ANNOTATION, source: 'none', link, differsFromDataset: false }
}

export interface GroundTruthMatchSummary {
  readonly photos: number
  // 정답 데이터의 정답을 쓰는 사진(직접 고른 정답이 데이터와 같은 경우 포함)
  readonly applied: number
  readonly manualDiffers: number
  readonly notInDataset: number
  readonly conflicting: number
  readonly hashPending: number
  readonly hashFailed: number
  // 불러온 사진 중 어느 것과도 연결되지 않은 정답 데이터 항목
  readonly datasetOnly: number
}

export function summarizeGroundTruthMatches(
  rows: readonly { readonly resolved: ResolvedAnnotation }[],
  dataset: GroundTruthDataset,
): GroundTruthMatchSummary {
  let applied = 0
  let manualDiffers = 0
  let notInDataset = 0
  let conflicting = 0
  let hashPending = 0
  let hashFailed = 0
  const matchedHashes = new Set<string>()
  for (const { resolved } of rows) {
    const { link } = resolved
    if (!link) continue
    switch (link.kind) {
      case 'matched':
        matchedHashes.add(link.entry.sha256)
        if (resolved.differsFromDataset) manualDiffers += 1
        else applied += 1
        break
      case 'not-in-dataset':
        notInDataset += 1
        break
      case 'conflicting':
        conflicting += 1
        break
      case 'hash-pending':
        hashPending += 1
        break
      case 'hash-failed':
        hashFailed += 1
        break
    }
  }
  return {
    photos: rows.length,
    applied,
    manualDiffers,
    notInDataset,
    conflicting,
    hashPending,
    hashFailed,
    datasetOnly: dataset.entries.size - matchedHashes.size,
  }
}

export interface GroundTruthExport {
  readonly entries: readonly GroundTruthEntry[]
  // 지금 불러온 사진에서 만든 항목
  readonly fromPhotos: number
  // 불러온 사진에 없어 정답 데이터에서 그대로 옮긴 항목
  readonly preserved: number
  // 정답을 고르지 않아 넣지 않은 사진
  readonly skippedUnlabeled: number
  // 정답은 있지만 해시가 없어(계산 중·실패) 넣지 않은 사진
  readonly skippedNoHash: number
  // 정답 데이터 안에서 충돌해 넣지 않은 해시
  readonly droppedConflicts: number
}

// 내보낼 정답 데이터 항목을 모은다. 사람이 고른 정답(label)이 있는 사진만 넣고 자동 판정은 쓰지 않는다.
// 정답 데이터를 불러왔다면 이번에 불러오지 않은 사진의 항목도 잃지 않도록 그대로 옮긴다.
export function collectGroundTruthEntries(
  rows: readonly { readonly hash: PhotoHash | undefined; readonly resolved: ResolvedAnnotation }[],
  dataset: GroundTruthDataset | null,
): GroundTruthExport {
  const byHash = new Map<string, GroundTruthEntry>()
  let skippedUnlabeled = 0
  let skippedNoHash = 0
  const sessionHashes = new Set<string>()
  for (const { hash, resolved } of rows) {
    if (hash?.status === 'ready') sessionHashes.add(hash.sha256)
    const { label } = resolved.annotation
    if (label === null) {
      skippedUnlabeled += 1
    } else if (hash?.status !== 'ready') {
      skippedNoHash += 1
    } else if (!byHash.has(hash.sha256)) {
      byHash.set(hash.sha256, { ...resolved.annotation, label, sha256: hash.sha256 })
    }
  }
  const fromPhotos = byHash.size

  let preserved = 0
  for (const [sha256, entry] of dataset?.entries ?? []) {
    if (sessionHashes.has(sha256)) continue
    byHash.set(sha256, entry)
    preserved += 1
  }
  const droppedConflicts = [...(dataset?.conflictingHashes ?? [])].filter((sha256) => !byHash.has(sha256)).length

  return { entries: [...byHash.values()], fromPhotos, preserved, skippedUnlabeled, skippedNoHash, droppedConflicts }
}
