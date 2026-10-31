import { describe, expect, it } from 'vitest'
import { buildEvaluationJson } from './evaluationExport.ts'
import {
  buildGroundTruthJson,
  GROUND_TRUTH_FORMAT,
  GROUND_TRUTH_NOTICE,
  MAX_GROUND_TRUTH_ENTRIES,
  MAX_GROUND_TRUTH_FILE_BYTES,
  MAX_NOTE_LENGTH,
  parseGroundTruthDataset,
  readGroundTruthFile,
  type GroundTruthEntry,
} from './groundTruthDataset.ts'

const hashOf = (digit: string) => digit.repeat(64)
const datasetText = (entries: unknown[], change: Record<string, unknown> = {}) =>
  JSON.stringify({ format: GROUND_TRUTH_FORMAT, version: 1, hashAlgorithm: 'SHA-256', entries, ...change })

const entry = (change: Partial<GroundTruthEntry> = {}): GroundTruthEntry => ({
  sha256: hashOf('a'),
  label: 'blurry',
  condition: 'camera-shake',
  sceneGroup: 2,
  origin: 'real-capture',
  sourceNote: null,
  processing: null,
  reviewed: true,
  ...change,
})

const uniqueHash = (index: number) => index.toString(16).padStart(64, '0')

function exportOk(entries: readonly GroundTruthEntry[]) {
  const result = buildGroundTruthJson(entries, new Date('2026-10-30T01:02:03Z'))
  if (!result.ok) throw new Error(`expected an export, got ${result.error}`)
  return result.text
}

function parseOk(text: string) {
  const result = parseGroundTruthDataset(text)
  if (!result.ok) throw new Error(`expected a dataset, got ${result.error}`)
  return result.dataset
}

describe('ground truth dataset', () => {
  it('reads entries by hash, lowercases the hash and fills optional fields', () => {
    const dataset = parseOk(
      datasetText([
        { sha256: hashOf('A'), label: 'sharp' },
        {
          sha256: hashOf('b'),
          label: 'blurry',
          condition: 'out-of-focus',
          sceneGroup: 4,
          origin: 'synthetic-edit',
          processing: '  가우시안 흐림 σ=3  ',
          sourceNote: '',
          reviewed: true,
        },
      ]),
    )
    expect(dataset.stats).toEqual({ total: 2, usable: 2, invalid: 0, duplicate: 0, conflicting: 0, invalidEntryNumbers: [] })
    expect(dataset.entries.get(hashOf('a'))).toEqual({
      sha256: hashOf('a'),
      label: 'sharp',
      condition: null,
      sceneGroup: null,
      origin: null,
      sourceNote: null,
      processing: null,
      reviewed: false,
    })
    expect(dataset.entries.get(hashOf('b'))).toMatchObject({ processing: '가우시안 흐림 σ=3', sourceNote: null, origin: 'synthetic-edit', reviewed: true })
  })

  it('skips broken entries and reports their positions without rejecting the rest', () => {
    const dataset = parseOk(
      datasetText([
        { sha256: hashOf('a'), label: 'sharp' },
        { sha256: 'not-a-hash', label: 'sharp' },
        { sha256: hashOf('b'), label: 'blury' },
        { sha256: hashOf('c'), label: null },
        { sha256: hashOf('d'), label: 'sharp', sceneGroup: 0 },
        { sha256: hashOf('e'), label: 'sharp', sceneGroup: 1.5 },
        { sha256: hashOf('f'), label: 'sharp', origin: 'ai-generated' },
        { sha256: hashOf('1'), label: 'sharp', reviewed: 'yes' },
        { sha256: hashOf('2'), label: 'sharp', sourceNote: 'x'.repeat(MAX_NOTE_LENGTH + 1) },
        'photo-3',
        null,
        { sha256: hashOf('3'), label: 'unsure', condition: 'texture' },
      ]),
    )
    expect(dataset.stats).toMatchObject({ total: 12, usable: 2, invalid: 10, invalidEntryNumbers: [2, 3, 4, 5, 6] })
    expect([...dataset.entries.keys()]).toEqual([hashOf('a'), hashOf('3')])
  })

  it('keeps one copy of exact duplicates and applies neither side of a conflict', () => {
    const dataset = parseOk(
      datasetText([
        entry({ sha256: hashOf('a') }),
        entry({ sha256: hashOf('a').toUpperCase() }),
        entry({ sha256: hashOf('b'), label: 'sharp' }),
        entry({ sha256: hashOf('b'), label: 'blurry' }),
        entry({ sha256: hashOf('b'), label: 'sharp' }),
        entry({ sha256: hashOf('c'), reviewed: true }),
        entry({ sha256: hashOf('c'), reviewed: false }),
      ]),
    )
    expect(dataset.stats).toMatchObject({ total: 7, usable: 1, duplicate: 1, conflicting: 2 })
    expect([...dataset.entries.keys()]).toEqual([hashOf('a')])
    expect([...dataset.conflictingHashes].sort()).toEqual([hashOf('b'), hashOf('c')])
  })

  it('rejects files that are not a ground truth dataset with a specific reason', () => {
    expect(parseGroundTruthDataset('{"format": "photo-selector-blur-ground-truth", ')).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseGroundTruthDataset('[]')).toEqual({ ok: false, error: 'not-ground-truth' })
    expect(parseGroundTruthDataset('null')).toEqual({ ok: false, error: 'not-ground-truth' })
    expect(parseGroundTruthDataset(datasetText([], { format: 'something-else' }))).toEqual({ ok: false, error: 'not-ground-truth' })
    expect(parseGroundTruthDataset(datasetText([], { version: 2 }))).toEqual({ ok: false, error: 'unsupported-version' })
    expect(parseGroundTruthDataset(datasetText([], { hashAlgorithm: 'MD5' }))).toEqual({ ok: false, error: 'unsupported-hash' })
    expect(parseGroundTruthDataset(datasetText([], { entries: {} }))).toEqual({ ok: false, error: 'not-ground-truth' })
    const tooMany = Array.from({ length: MAX_GROUND_TRUTH_ENTRIES + 1 }, () => ({}))
    expect(parseGroundTruthDataset(datasetText(tooMany))).toEqual({ ok: false, error: 'too-many-entries' })
  })

  // 평가 결과의 photo-N은 세션마다 바뀌므로 사진과 연결하지 않는다.
  it('refuses an evaluation result file instead of guessing which photo each row was', () => {
    const evaluation = buildEvaluationJson([], { device: '', analysisPath: 'worker', userAgent: null }, new Date())
    expect(parseGroundTruthDataset(evaluation)).toEqual({ ok: false, error: 'evaluation-result' })
  })

  it('only copies known fields and never runs or keeps anything else from the file', () => {
    const text = `{"format":"${GROUND_TRUTH_FORMAT}","version":1,"hashAlgorithm":"SHA-256","entries":[{"sha256":"${hashOf('a')}","label":"sharp","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"verdict":"blurry","fileName":"secret.jpg"}]}`
    const dataset = parseOk(text)
    const parsed = dataset.entries.get(hashOf('a'))!
    expect(Object.keys(parsed).sort()).toEqual(['condition', 'label', 'origin', 'processing', 'reviewed', 'sceneGroup', 'sha256', 'sourceNote'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })

  it('refuses files larger than the limit without reading them', async () => {
    const huge = new Blob(['x'])
    Object.defineProperty(huge, 'size', { value: MAX_GROUND_TRUTH_FILE_BYTES + 1 })
    let read = false
    huge.text = async () => {
      read = true
      return ''
    }
    expect(await readGroundTruthFile(huge)).toEqual({ ok: false, error: 'too-large' })
    expect(read).toBe(false)

    const unreadable = new Blob(['{}'])
    unreadable.text = () => Promise.reject(new Error('NotReadableError'))
    expect(await readGroundTruthFile(unreadable)).toEqual({ ok: false, error: 'unreadable' })
    expect(await readGroundTruthFile(new Blob([datasetText([entry()])]))).toMatchObject({ ok: true })
  })

  it('exports human labels sorted by hash with the sharing notice, and reads them back unchanged', () => {
    const entries = [
      entry({ sha256: hashOf('c'), label: 'sharp', origin: 'public-image', sourceNote: 'https://example.org/photo (CC BY 4.0)' }),
      entry({ sha256: hashOf('a'), processing: '가로 손떨림 25px' }),
    ]
    const text = exportOk(entries)
    const file = JSON.parse(text)
    expect(file).toMatchObject({
      format: GROUND_TRUTH_FORMAT,
      version: 1,
      hashAlgorithm: 'SHA-256',
      exportedAt: '2026-10-30T01:02:03.000Z',
      notice: GROUND_TRUTH_NOTICE,
    })
    expect(file.entries.map((item: GroundTruthEntry) => item.sha256)).toEqual([hashOf('a'), hashOf('c')])
    expect(Object.keys(file.entries[0]).sort()).toEqual(['condition', 'label', 'origin', 'processing', 'reviewed', 'sceneGroup', 'sha256', 'sourceNote'])
    expect(text).not.toMatch(/verdict|score|photo-\d|fileName/)

    const roundTrip = parseOk(text)
    expect(roundTrip.entries.get(hashOf('c'))).toEqual(entries[0])
    expect(roundTrip.entries.get(hashOf('a'))).toEqual(entries[1])
  })

  it('exports an empty entry list as valid JSON', () => {
    expect(parseOk(exportOk([])).stats.total).toBe(0)
  })

  it('exports the largest loadable dataset so that it can be loaded again', async () => {
    const entries = Array.from({ length: MAX_GROUND_TRUTH_ENTRIES }, (_, index) =>
      entry({ sha256: uniqueHash(index), condition: null, sceneGroup: null, origin: null, reviewed: false }),
    )
    const imported = parseOk(datasetText(entries.map(({ sha256, label }) => ({ sha256, label }))))
    expect(imported.stats.usable).toBe(MAX_GROUND_TRUTH_ENTRIES)

    const text = exportOk([...imported.entries.values()])
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_GROUND_TRUTH_FILE_BYTES)
    const reloaded = await readGroundTruthFile(new Blob([text]))
    if (!reloaded.ok) throw new Error(`expected a dataset, got ${reloaded.error}`)
    expect(reloaded.dataset.stats).toMatchObject({ total: MAX_GROUND_TRUTH_ENTRIES, usable: MAX_GROUND_TRUTH_ENTRIES, invalid: 0 })
  })

  it('refuses to export a file that could not be loaded again', () => {
    const tooMany = Array.from({ length: MAX_GROUND_TRUTH_ENTRIES + 1 }, (_, index) => entry({ sha256: uniqueHash(index) }))
    expect(buildGroundTruthJson(tooMany, new Date())).toEqual({ ok: false, error: 'too-many-entries' })

    // 설명이 긴 항목은 개수 한도 안이어도 크기 한도를 넘을 수 있다(한글 1자 = UTF-8 3바이트).
    const longNote = '가'.repeat(MAX_NOTE_LENGTH)
    const tooLarge = Array.from({ length: 3_000 }, (_, index) =>
      entry({ sha256: uniqueHash(index), sourceNote: longNote, processing: longNote }),
    )
    expect(buildGroundTruthJson(tooLarge, new Date())).toEqual({ ok: false, error: 'too-large' })
    expect(buildGroundTruthJson(tooLarge.slice(0, 2_000), new Date())).toMatchObject({ ok: true })
  })
})
