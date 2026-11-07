import { beforeAll, describe, expect, it, vi } from 'vitest'
import { adjustTone, jpegLike, resizeBilinear } from '../test/photoVariants.ts'
import { fingerprintOf, renderWideScene, viewOf } from '../test/similarScenes.ts'
import { createRandom, gaussianBlur, renderScene, renderUniform } from '../test/syntheticImages.ts'
import type { PhotoFingerprint } from './photoFingerprint.ts'
import { comparePhotos, prepareFingerprint, type PhotoComparison, type PreparedFingerprint } from './photoSimilarity.ts'
import { createSimilarityIndex, type SimilarityIndex, type SimilarPhotoGroup } from './similarPhotoGroups.ts'

// 합성 장면으로 묶음 규칙을 확인한다. 실제 사진으로 검증한 결과가 아니다.
type Library = Record<string, PhotoFingerprint>

let library: Library
beforeAll(() => {
  const portrait = renderWideScene(21)
  const burst = renderWideScene(22)
  const pan = renderWideScene(23)
  const original = viewOf(portrait)
  library = {
    // 거의 같은 사진 세 장(크기·압축·밝기만 다름)
    original: fingerprintOf(original),
    resized: fingerprintOf(jpegLike(resizeBilinear(original, 320, 240), 40)),
    brighter: fingerprintOf(adjustTone(original, { gain: 0.8, offset: 40 })),
    portraitPan: fingerprintOf(viewOf(portrait, 8, 4)),
    // 조금 움직여 다시 찍은 두 장
    burstA: fingerprintOf(viewOf(burst)),
    burstB: fingerprintOf(viewOf(burst, 16, 8)),
    // 천천히 옮겨 찍은 세 장: 이웃끼리만 비슷하고 처음과 끝은 이동이 비교 범위를 넘는다.
    panStart: fingerprintOf(viewOf(pan)),
    panMiddle: fingerprintOf(viewOf(pan, 16, 8)),
    panEnd: fingerprintOf(viewOf(pan, 32, 16)),
    // 다른 사진과 윤곽이 부족한 사진
    lonely: fingerprintOf(gaussianBlur(renderScene(512, 384, 40), 0.8)),
    wall: fingerprintOf(renderUniform(512, 384, 120)),
  }
})

const prepareAll = (name: string) => prepareFingerprint(library[name]!)
const entriesOf = (names: readonly string[]) => new Map(names.map((name) => [name, library[name]!]))

// 사진 이름(지문 내용) 기준으로 묶음을 비교하기 쉽게 정렬한다.
function namedGroups(groups: readonly SimilarPhotoGroup[], nameOf: (id: string) => string) {
  return groups
    .map((group) => ({ kind: group.kind, names: group.photoIds.map(nameOf).sort() }))
    .sort((a, b) => a.names[0]!.localeCompare(b.names[0]!))
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = createRandom(seed)
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy
}

// 지문 목록을 맞추고 남은 비교를 모두 끝낸다.
function settle(index: SimilarityIndex, entries: ReadonlyMap<string, PhotoFingerprint>) {
  index.sync(entries)
  expect(index.work(Number.POSITIVE_INFINITY)).toBe(true)
  expect(index.pendingCount).toBe(0)
}

describe('createSimilarityIndex', () => {
  it('separates almost identical photos from similar ones and leaves different photos out', () => {
    const index = createSimilarityIndex()
    settle(index, entriesOf(Object.keys(library).filter((name) => name !== 'portraitPan')))

    const groups = namedGroups(index.groups(), (id) => id)
    expect(groups.filter((group) => group.names.includes('original'))).toEqual([
      { kind: 'same', names: ['brighter', 'original', 'resized'] },
    ])
    expect(groups.filter((group) => group.names.includes('burstA'))).toEqual([{ kind: 'similar', names: ['burstA', 'burstB'] }])
    expect(groups.flatMap((group) => group.names)).not.toContain('lonely')
    expect(groups.flatMap((group) => group.names)).not.toContain('wall')
    expect(index.statusOf('wall')).toBe('incomparable')
    expect(index.statusOf('lonely')).toBe('comparable')
    expect(index.statusOf('missing')).toBeUndefined()
  })

  it('labels a group with a slightly moved shot as similar, the more cautious wording', () => {
    const index = createSimilarityIndex()
    settle(index, entriesOf(['original', 'resized', 'portraitPan']))

    expect(namedGroups(index.groups(), (id) => id)).toEqual([{ kind: 'similar', names: ['original', 'portraitPan', 'resized'] }])
  })

  it('does not chain photos into one group when the first and last are not similar', () => {
    expect(comparePhotos(prepareAll('panStart'), prepareAll('panMiddle')).kind).toBe('similar')
    expect(comparePhotos(prepareAll('panMiddle'), prepareAll('panEnd')).kind).toBe('similar')
    expect(['uncertain', 'different']).toContain(comparePhotos(prepareAll('panStart'), prepareAll('panEnd')).kind)

    const index = createSimilarityIndex()
    settle(index, entriesOf(['panStart', 'panMiddle', 'panEnd']))

    const groups = index.groups()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.photoIds).toHaveLength(2)
    expect(groups[0]!.photoIds).toContain('panMiddle')
  })

  it('makes every pair inside a group meet the threshold (complete linkage)', () => {
    // 가짜 비교: A-B, B-C, A-C, C-D만 비슷하다. D는 A·B와 비슷하지 않으므로 {A,B,C}에 들어가지 못한다.
    const similarPairs = new Set(['original|resized', 'brighter|resized', 'brighter|original', 'brighter|lonely'])
    // 가짜 비교가 쓰이도록 lonely를 pHash 후보로 만든다(실제 pHash로는 후보가 아니다).
    const lonelyLike = { ...library.lonely!, hash: library.original!.hash }
    const nameOfFingerprint = new Map(Object.entries(library).map(([name, fingerprint]) => [fingerprint, name]))
    nameOfFingerprint.set(lonelyLike, 'lonely')
    const compare = (first: PreparedFingerprint, second: PreparedFingerprint): PhotoComparison => {
      const key = [nameOfFingerprint.get(first.fingerprint)!, nameOfFingerprint.get(second.fingerprint)!].sort().join('|')
      const kind = similarPairs.has(key) ? 'similar' : 'different'
      return { kind, hashDistance: 0, correlation: key === 'brighter|lonely' ? 0.99 : 0.8, detailedCells: 16, matchedCells: 16 }
    }
    const index = createSimilarityIndex({ compare })
    settle(index, new Map([...entriesOf(['original', 'resized', 'brighter']), ['lonely', lonelyLike]]))

    // 가장 비슷한 C-D가 먼저 묶이고, A·B는 D와 비슷하지 않아 따로 묶인다.
    expect(namedGroups(index.groups(), (id) => id)).toEqual([
      { kind: 'similar', names: ['brighter', 'lonely'] },
      { kind: 'similar', names: ['original', 'resized'] },
    ])
  })

  it('builds the same groups whatever order and ids the photos were imported with', () => {
    const names = Object.keys(library)
    const reference = createSimilarityIndex()
    settle(reference, entriesOf(names))
    const expected = namedGroups(reference.groups(), (id) => id)

    for (const seed of [1, 2, 3, 4, 5]) {
      const order = shuffled(names, seed)
      const ids = new Map(order.map((name, position) => [`photo-${position + 1}`, name]))
      const index = createSimilarityIndex()
      // 분석이 끝나는 순서대로 한 장씩 추가한다. 홀수 seed에서는 비교가 끝나기 전에 다음 사진이 온다.
      const entries = new Map<string, PhotoFingerprint>()
      for (const [id, name] of ids) {
        entries.set(id, library[name]!)
        index.sync(new Map(entries))
        if (seed % 2 === 0) index.work(Number.POSITIVE_INFINITY)
      }
      index.work(Number.POSITIVE_INFINITY)
      expect(namedGroups(index.groups(), (id) => ids.get(id)!)).toEqual(expected)
    }
  })

  it('compares each new photo once with the photos already there and updates groups when photos are removed', () => {
    const compare = vi.fn(comparePhotos)
    const index = createSimilarityIndex({ compare })
    const entries = entriesOf(['burstA', 'burstB'])
    settle(index, entries)
    expect(compare).toHaveBeenCalledTimes(1)
    expect(namedGroups(index.groups(), (id) => id)).toEqual([{ kind: 'similar', names: ['burstA', 'burstB'] }])

    // 후보가 아닌 사진(pHash가 먼 사진)은 구조 비교를 하지 않고, 같은 목록을 다시 맞춰도 비교하지 않는다.
    entries.set('lonely', library.lonely!)
    settle(index, entries)
    settle(index, entries)
    expect(compare).toHaveBeenCalledTimes(1)

    // 묶음의 사진을 빼면 혼자 남은 사진은 묶음에서 빠진다.
    entries.delete('burstA')
    settle(index, entries)
    expect(index.groups()).toEqual([])

    // 다시 추가하면 새 사진으로 한 번 비교한다.
    entries.set('burstA-again', library.burstA!)
    settle(index, entries)
    expect(compare).toHaveBeenCalledTimes(2)
    expect(index.comparisonCount).toBe(2)
    expect(namedGroups(index.groups(), (id) => id)).toEqual([{ kind: 'similar', names: ['burstA-again', 'burstB'] }])
  })

  it('does not compare photos without enough outlines', () => {
    const compare = vi.fn(comparePhotos)
    const index = createSimilarityIndex({ compare })
    settle(index, new Map([['wall', library.wall!], ['wall2', library.wall!], ['burstA', library.burstA!]]))

    expect(compare).not.toHaveBeenCalled()
    expect(index.groups()).toEqual([])
  })

  it('spreads comparisons over several time slices and reaches the same groups', () => {
    let clock = 0
    const compare = (first: PreparedFingerprint, second: PreparedFingerprint) => {
      clock += 5
      return comparePhotos(first, second)
    }
    const names = ['original', 'resized', 'brighter', 'portraitPan', 'burstA', 'burstB', 'panStart', 'panMiddle', 'panEnd']
    const index = createSimilarityIndex({ compare, now: () => clock })
    index.sync(entriesOf(names))
    expect(index.pendingCount).toBe(names.length)

    let slices = 1
    let before = clock
    while (!index.work(8)) {
      // 한 조각에서 비교는 두 번(10ms)을 넘지 않는다.
      expect(clock - before).toBeLessThanOrEqual(10)
      before = clock
      slices += 1
    }
    expect(slices).toBeGreaterThan(1)
    expect(index.pendingCount).toBe(0)

    const reference = createSimilarityIndex()
    settle(reference, entriesOf(names))
    expect(namedGroups(index.groups(), (id) => id)).toEqual(namedGroups(reference.groups(), (id) => id))
  })

  it('stops comparing photos that have too many lookalikes and resumes when photos are removed', () => {
    // original·resized·brighter·portraitPan은 서로 pHash 후보다(각 3장). 후보가 2장을 넘으면 비교하지 않는다.
    const names = ['original', 'resized', 'brighter', 'portraitPan', 'burstA', 'burstB']
    const index = createSimilarityIndex({ maxCandidates: 2 })
    const entries = entriesOf(names)
    settle(index, entries)

    expect(index.statusOf('original')).toBe('crowded')
    expect(index.statusOf('portraitPan')).toBe('crowded')
    expect(index.statusOf('burstA')).toBe('comparable')
    expect(namedGroups(index.groups(), (id) => id)).toEqual([{ kind: 'similar', names: ['burstA', 'burstB'] }])

    entries.delete('portraitPan')
    settle(index, entries)
    expect(index.statusOf('original')).toBe('comparable')
    const expected = [
      { kind: 'same', names: ['brighter', 'original', 'resized'] },
      { kind: 'similar', names: ['burstA', 'burstB'] },
    ]
    expect(namedGroups(index.groups(), (id) => id)).toEqual(expected)

    // 같은 사진 집합이면 추가·제거 순서와 관계없이 같은 결과다.
    const other = createSimilarityIndex({ maxCandidates: 2 })
    const growing = new Map<string, PhotoFingerprint>()
    for (const name of [...names].reverse()) {
      growing.set(name, library[name]!)
      other.sync(new Map(growing))
      other.work(Number.POSITIVE_INFINITY)
    }
    growing.delete('portraitPan')
    settle(other, growing)
    expect(namedGroups(other.groups(), (id) => id)).toEqual(expected)
  })

  it('compares again from the start a photo that became crowded and then comparable during its own comparisons', () => {
    // pHash만 바꾼 지문으로 후보 관계를 정한다. X는 Y·W·Z1·Z2와, Z1은 Z2와 후보이고 Y·W는 X와만 후보다.
    const base = library.burstA!
    const withHash = (hash: readonly [number, number]): PhotoFingerprint => ({ ...base, hash })
    const photos = {
      X: withHash([0, 0]),
      Y: withHash([0, 0x7fff]),
      W: withHash([0, 0x3fff8000]),
      Z1: withHash([0x7fff, 0]),
      Z2: withHash([0x7fff, 0]),
    }
    const nameOf = new Map(Object.entries(photos).map(([name, fingerprint]) => [fingerprint, name]))
    const scores: Record<string, number> = { 'X|Y': 0.95, 'W|X': 0.8 }
    let clock = 0
    const compare = (first: PreparedFingerprint, second: PreparedFingerprint): PhotoComparison => {
      clock += 5
      const key = [nameOf.get(first.fingerprint)!, nameOf.get(second.fingerprint)!].sort().join('|')
      const score = scores[key]
      return { kind: score ? 'similar' : 'different', hashDistance: 0, correlation: score ?? 0, detailedCells: 16, matchedCells: 16 }
    }
    const pick = (...names: (keyof typeof photos)[]) => new Map(names.map((name) => [name, photos[name]]))
    const index = createSimilarityIndex({ compare, now: () => clock, maxCandidates: 3 })

    settle(index, pick('Y', 'W'))
    index.sync(pick('Y', 'W', 'X'))
    // X가 Y와 비교한 뒤 시간 제한으로 멈춘다.
    expect(index.work(4)).toBe(false)
    // Z1·Z2가 들어와 X의 후보가 4장이 되어 비교 결과를 버리고, 둘이 빠져 다시 비교할 수 있게 된다.
    index.sync(pick('Y', 'W', 'X', 'Z1', 'Z2'))
    expect(index.statusOf('X')).toBe('crowded')
    settle(index, pick('Y', 'W', 'X'))

    const fresh = createSimilarityIndex({ compare, maxCandidates: 3 })
    settle(fresh, pick('Y', 'W', 'X'))
    expect(namedGroups(fresh.groups(), (id) => id)).toEqual([{ kind: 'similar', names: ['X', 'Y'] }])
    expect(namedGroups(index.groups(), (id) => id)).toEqual(namedGroups(fresh.groups(), (id) => id))
  })

  it('keeps to the time limit when many queued photos are skipped without comparing', () => {
    // 후보 상한이 0이라 모든 사진이 후보 초과로 비교하지 않는다. 시간은 확인할 때마다 1ms씩 흐른다.
    let clock = 0
    const compare = vi.fn(comparePhotos)
    const index = createSimilarityIndex({ compare, now: () => (clock += 1), maxCandidates: 0 })
    index.sync(new Map(Array.from({ length: 300 }, (_, position) => [`photo-${position}`, library.burstA!])))

    expect(index.work(8)).toBe(false)
    expect(index.pendingCount).toBeGreaterThan(280)
    let slices = 1
    while (!index.work(8)) slices += 1
    expect(slices).toBeGreaterThan(30)
    expect(compare).not.toHaveBeenCalled()
  })
})
