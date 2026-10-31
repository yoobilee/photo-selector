import { describe, expect, it } from 'vitest'
import {
  EMPTY_ANNOTATION,
  GROUND_TRUTH_FORMAT,
  parseGroundTruthDataset,
  type GroundTruthDataset,
  type GroundTruthEntry,
  type PhotoAnnotation,
} from './groundTruthDataset.ts'
import {
  collectGroundTruthEntries,
  linkGroundTruth,
  resolveAnnotation,
  summarizeGroundTruthMatches,
  toAnnotation,
  type PhotoHash,
} from './groundTruthMatch.ts'

const hashOf = (digit: string) => digit.repeat(64)
const ready = (digit: string): PhotoHash => ({ status: 'ready', sha256: hashOf(digit) })
const entry = (digit: string, change: Partial<GroundTruthEntry> = {}): GroundTruthEntry => ({
  ...EMPTY_ANNOTATION,
  sha256: hashOf(digit),
  label: 'blurry',
  ...change,
})

function datasetOf(entries: readonly GroundTruthEntry[]): GroundTruthDataset {
  const result = parseGroundTruthDataset(JSON.stringify({ format: GROUND_TRUTH_FORMAT, version: 1, hashAlgorithm: 'SHA-256', entries }))
  if (!result.ok) throw new Error(result.error)
  return result.dataset
}

const row = (hash: PhotoHash | undefined, manual: PhotoAnnotation | undefined, dataset: GroundTruthDataset | null) => ({
  hash,
  resolved: resolveAnnotation(manual, dataset ? linkGroundTruth(hash, dataset) : null),
})

describe('ground truth matching', () => {
  const dataset = datasetOf([
    entry('a', { label: 'sharp', origin: 'real-capture', reviewed: true }),
    entry('b', { label: 'blurry', processing: '가우시안 흐림 σ=3', origin: 'synthetic-edit' }),
    entry('c', { label: 'sharp' }),
    entry('c', { label: 'blurry' }),
    entry('d', { label: 'unsure' }),
  ])

  it('links a photo only when its hash is known, present and not in conflict', () => {
    expect(linkGroundTruth(undefined, dataset)).toEqual({ kind: 'hash-pending' })
    expect(linkGroundTruth({ status: 'failed' }, dataset)).toEqual({ kind: 'hash-failed' })
    expect(linkGroundTruth(ready('9'), dataset)).toEqual({ kind: 'not-in-dataset' })
    expect(linkGroundTruth(ready('c'), dataset)).toEqual({ kind: 'conflicting' })
    expect(linkGroundTruth(ready('a'), dataset)).toEqual({ kind: 'matched', entry: dataset.entries.get(hashOf('a')) })
  })

  it('applies the dataset only when nobody picked a label by hand', () => {
    const fromData = resolveAnnotation(undefined, linkGroundTruth(ready('b'), dataset))
    expect(fromData).toMatchObject({ source: 'dataset', differsFromDataset: false })
    expect(fromData.annotation).toEqual(toAnnotation(dataset.entries.get(hashOf('b'))!))

    const manual: PhotoAnnotation = { ...EMPTY_ANNOTATION, label: 'sharp' }
    const kept = resolveAnnotation(manual, linkGroundTruth(ready('b'), dataset))
    expect(kept).toMatchObject({ source: 'manual', differsFromDataset: true, annotation: manual })

    // 사진 단위로 판단한다. 촬영 조건만 고친 사진에도 정답 데이터의 정답을 섞지 않는다.
    const conditionOnly: PhotoAnnotation = { ...EMPTY_ANNOTATION, condition: 'indoor' }
    expect(resolveAnnotation(conditionOnly, linkGroundTruth(ready('b'), dataset))).toMatchObject({
      source: 'manual',
      differsFromDataset: true,
      annotation: conditionOnly,
    })

    const same = resolveAnnotation(toAnnotation(dataset.entries.get(hashOf('b'))!), linkGroundTruth(ready('b'), dataset))
    expect(same).toMatchObject({ source: 'manual', differsFromDataset: false })

    expect(resolveAnnotation(undefined, linkGroundTruth(ready('c'), dataset))).toMatchObject({ source: 'none', annotation: EMPTY_ANNOTATION })
    expect(resolveAnnotation(undefined, null)).toEqual({ annotation: EMPTY_ANNOTATION, source: 'none', link: null, differsFromDataset: false })
  })

  it('counts applied, kept, missing, conflicting and pending photos and the entries no photo matched', () => {
    const rows = [
      row(ready('a'), undefined, dataset),
      row(ready('b'), { ...EMPTY_ANNOTATION, label: 'sharp' }, dataset),
      row(ready('c'), undefined, dataset),
      row(ready('9'), undefined, dataset),
      row(undefined, undefined, dataset),
      row({ status: 'failed' }, undefined, dataset),
    ]
    expect(summarizeGroundTruthMatches(rows, dataset)).toEqual({
      photos: 6,
      applied: 1,
      manualDiffers: 1,
      notInDataset: 1,
      conflicting: 1,
      hashPending: 1,
      hashFailed: 1,
      // d만 어떤 사진과도 연결되지 않았다.
      datasetOnly: 1,
    })
  })

  it('exports labeled photos and keeps dataset entries for photos that are not loaded', () => {
    const result = collectGroundTruthEntries(
      [
        // 정답 데이터에서 적용된 사진
        row(ready('a'), undefined, dataset),
        // 직접 고친 사진은 고친 값으로 내보낸다.
        row(ready('b'), { ...EMPTY_ANNOTATION, label: 'unsure', reviewed: true }, dataset),
        // 데이터 안 충돌을 직접 고른 정답으로 해결한 사진
        row(ready('c'), { ...EMPTY_ANNOTATION, label: 'sharp' }, dataset),
        // 정답이 없는 사진과 해시가 없는 사진은 넣지 않는다.
        row(ready('7'), undefined, dataset),
        row(undefined, { ...EMPTY_ANNOTATION, label: 'sharp' }, dataset),
        row({ status: 'failed' }, { ...EMPTY_ANNOTATION, label: 'blurry' }, dataset),
      ],
      dataset,
    )
    expect(result).toMatchObject({ fromPhotos: 3, preserved: 1, skippedUnlabeled: 1, skippedNoHash: 2, droppedConflicts: 0 })
    const byHash = new Map(result.entries.map((item) => [item.sha256, item]))
    expect(byHash.get(hashOf('a'))).toEqual(dataset.entries.get(hashOf('a')))
    expect(byHash.get(hashOf('b'))).toMatchObject({ label: 'unsure', reviewed: true, processing: null })
    expect(byHash.get(hashOf('c'))).toMatchObject({ label: 'sharp' })
    expect(byHash.get(hashOf('d'))).toEqual(dataset.entries.get(hashOf('d')))
    expect(byHash.has(hashOf('7'))).toBe(false)
  })

  it('drops conflicting hashes nobody resolved and never uses automatic verdicts as labels', () => {
    const onlyConflict = collectGroundTruthEntries([], dataset)
    expect(onlyConflict).toMatchObject({ fromPhotos: 0, preserved: 3, droppedConflicts: 1 })

    const withoutDataset = collectGroundTruthEntries([row(ready('a'), undefined, null), row(ready('b'), undefined, null)], null)
    expect(withoutDataset).toEqual({ entries: [], fromPhotos: 0, preserved: 0, skippedUnlabeled: 2, skippedNoHash: 0, droppedConflicts: 0 })
  })
})
