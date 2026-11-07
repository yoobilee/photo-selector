// 사진 지문으로 비슷한 사진 묶음을 만든다. React·DOM에 의존하지 않는 순수 모듈이다.
//
// - 사진이 추가되면 새 사진을 기존 사진과 한 번씩 비교하고 결과를 기억한다. 같은 쌍을 다시 비교하지 않는다.
// - 비교는 work(budgetMs)로 나눠 실행해 화면(메인 스레드)을 오래 막지 않는다. 끝나지 않은 사진은 확인 중이다.
// - 사진이 빠지면 그 사진의 비교 결과만 버린다.
// - pHash 후보(빠른 확인)가 MAX_CANDIDATES_PER_PHOTO장을 넘는 사진(같은 장면을 수백 장 찍은 경우 등)은 비교량과 메모리가
//   사진 수의 제곱으로 늘지 않도록 비교하지 않는다(crowded). 후보 수는 사진 집합만으로 정해지므로 가져온 순서와 관계없다.
// - 묶음은 묶음 안의 모든 사진 쌍이 기준(same·similar)을 만족할 때만 만든다(완전 연결).
//   A-B, B-C만 비슷하고 A-C가 다르면 셋을 한 묶음으로 만들지 않는다.
// - 가장 비슷한 쌍부터 합치고, 같은 값이면 지문 내용으로 정한 순서를 쓴다. 비교가 모두 끝나면 가져온 순서·사진 id와
//   관계없이 같은 사진 집합은 같은 묶음이 된다.
import type { PhotoFingerprint } from './photoFingerprint.ts'
import {
  compareFingerprintOrder,
  comparePhotos,
  isCandidatePair,
  prepareFingerprint,
  type PhotoComparison,
  type PreparedFingerprint,
} from './photoSimilarity.ts'

// 한 사진의 pHash 후보가 이보다 많으면 비교하지 않는다.
export const MAX_CANDIDATES_PER_PHOTO = 100

// same: 묶음의 모든 쌍이 거의 같은 사진, similar: 하나라도 비슷한 사진(더 보수적인 표현)
export type SimilarGroupKind = 'same' | 'similar'

export interface SimilarPhotoGroup {
  readonly kind: SimilarGroupKind
  // 지문 내용 순서. 화면 순서는 호출자가 정한다.
  readonly photoIds: readonly string[]
}

// comparable: 비교 대상, incomparable: 윤곽이 부족해 비교하지 않음, crowded: 후보가 너무 많아 비교하지 않음
export type PhotoComparisonStatus = 'comparable' | 'incomparable' | 'crowded'

interface Link {
  readonly kind: 'same' | 'similar'
  readonly score: number
}

interface Entry {
  readonly prepared: PreparedFingerprint
  // 다른 사진 중 isCandidatePair인 사진 수
  candidateCount: number
  // queued: 다른 사진과의 비교가 남음, settled: 끝남
  state: 'queued' | 'settled'
}

interface Job {
  readonly id: string
  // 시작할 때 비교를 마친 사진 목록과 다음에 비교할 위치
  others: string[] | null
  cursor: number
}

export interface SimilarityIndex {
  // 지문 목록을 entries와 같게 맞춘다. 비교는 하지 않고 예약만 한다. 같은 id에 다른 지문이 오면 새 사진으로 본다.
  sync(entries: ReadonlyMap<string, PhotoFingerprint>): void
  // 예약된 비교를 budgetMs 동안 한다. 남은 비교가 없으면 true
  work(budgetMs: number): boolean
  // 비교가 끝나지 않은 사진 수
  readonly pendingCount: number
  // 끝난 비교만으로 만든 묶음
  groups(): SimilarPhotoGroup[]
  // 목록에 없으면 undefined
  statusOf(id: string): PhotoComparisonStatus | undefined
  // 지금까지 실행한 두 사진 비교 횟수(반복 비교가 없는지 확인용)
  readonly comparisonCount: number
}

export interface SimilarityIndexOptions {
  readonly compare?: (first: PreparedFingerprint, second: PreparedFingerprint) => PhotoComparison
  readonly now?: () => number
  readonly maxCandidates?: number
}

export function createSimilarityIndex({
  compare = comparePhotos,
  now = () => performance.now(),
  maxCandidates = MAX_CANDIDATES_PER_PHOTO,
}: SimilarityIndexOptions = {}): SimilarityIndex {
  const entries = new Map<string, Entry>()
  // same·similar 쌍만 양방향으로 기억한다(다른 사진 쌍은 기억하지 않는다).
  const links = new Map<string, Map<string, Link>>()
  const queue: Job[] = []
  let comparisonCount = 0

  const isCrowded = (entry: Entry) => entry.candidateCount > maxCandidates
  const isActive = (entry: Entry | undefined): entry is Entry =>
    entry !== undefined && entry.prepared.comparable && !isCrowded(entry)

  const dropLinks = (id: string) => {
    for (const other of links.get(id)?.keys() ?? []) links.get(other)?.delete(id)
    links.delete(id)
  }

  // 이미 예약된 사진이면 처음부터 다시 비교한다(후보 초과로 비교 결과를 버린 뒤 다시 비교할 때 앞서 지나간 사진을 빠뜨리지 않게).
  const enqueue = (id: string) => {
    entries.get(id)!.state = 'queued'
    const job = queue.find((queued) => queued.id === id)
    if (job) {
      job.others = null
      job.cursor = 0
    } else {
      queue.push({ id, others: null, cursor: 0 })
    }
  }

  // 후보 수가 기준을 넘거나 내려간 사진을 처리한다. 넘으면 비교 결과를 버리고, 내려가면 다시 비교한다.
  const updateCandidateCount = (id: string, entry: Entry, change: number) => {
    const wasCrowded = isCrowded(entry)
    entry.candidateCount += change
    if (!wasCrowded && isCrowded(entry)) dropLinks(id)
    else if (wasCrowded && !isCrowded(entry)) enqueue(id)
  }

  const remove = (id: string) => {
    const entry = entries.get(id)!
    entries.delete(id)
    dropLinks(id)
    const jobIndex = queue.findIndex((job) => job.id === id)
    if (jobIndex !== -1) queue.splice(jobIndex, 1)
    if (!entry.prepared.comparable) return
    for (const [otherId, other] of entries) {
      if (isCandidatePair(entry.prepared, other.prepared)) updateCandidateCount(otherId, other, -1)
    }
  }

  const add = (id: string, fingerprint: PhotoFingerprint) => {
    const entry: Entry = { prepared: prepareFingerprint(fingerprint), candidateCount: 0, state: 'settled' }
    if (entry.prepared.comparable) {
      for (const [otherId, other] of entries) {
        if (!isCandidatePair(entry.prepared, other.prepared)) continue
        entry.candidateCount += 1
        updateCandidateCount(otherId, other, 1)
      }
    }
    entries.set(id, entry)
    if (entry.prepared.comparable) enqueue(id)
  }

  const link = (a: string, b: string, value: Link) => {
    if (!links.has(a)) links.set(a, new Map())
    if (!links.has(b)) links.set(b, new Map())
    links.get(a)!.set(b, value)
    links.get(b)!.set(a, value)
  }

  return {
    sync(next) {
      for (const [id, entry] of [...entries]) {
        if (next.get(id) !== entry.prepared.fingerprint) remove(id)
      }
      for (const [id, fingerprint] of next) {
        if (!entries.has(id)) add(id, fingerprint)
      }
    },

    work(budgetMs) {
      const deadline = now() + budgetMs
      while (queue.length > 0) {
        const job = queue[0]!
        const entry = entries.get(job.id)!
        if (isActive(entry)) {
          // 비교를 마친 사진과만 비교한다. 아직 예약된 사진은 자기 차례에 이 사진과 비교한다.
          job.others ??= [...entries].filter(([, other]) => other.state === 'settled').map(([otherId]) => otherId)
          while (job.cursor < job.others.length) {
            const otherId = job.others[job.cursor]!
            job.cursor += 1
            const other = entries.get(otherId)
            if (isActive(other) && other.state === 'settled' && isCandidatePair(entry.prepared, other.prepared)) {
              comparisonCount += 1
              const comparison = compare(entry.prepared, other.prepared)
              if (comparison.kind === 'same' || comparison.kind === 'similar') {
                link(job.id, otherId, { kind: comparison.kind, score: comparison.correlation ?? 0 })
              }
            }
            // 비교하지 않고 건너뛴 사진도 시간을 확인한다(건너뛸 사진이 많을 때 시간 제한을 넘지 않게).
            if (now() >= deadline) return false
          }
        }
        queue.shift()
        entry.state = 'settled'
        // 비교할 수 없는(후보 초과·윤곽 부족) 사진이 많이 쌓여도 한 번에 모두 처리하지 않는다.
        if (queue.length > 0 && now() >= deadline) return false
      }
      return true
    },

    get pendingCount() {
      return queue.length
    },

    groups() {
      // 지문 내용 순서로 순위를 매긴다. 같은 지문은 서로 바꿔도 결과가 같다.
      const linkedIds = [...links.keys()].sort((first, second) =>
        compareFingerprintOrder(entries.get(first)!.prepared.fingerprint, entries.get(second)!.prepared.fingerprint),
      )
      const rank = new Map(linkedIds.map((id, index) => [id, index]))
      const edges: { a: string; b: string; score: number }[] = []
      for (const [a, neighbors] of links) {
        for (const [b, value] of neighbors) if (rank.get(a)! < rank.get(b)!) edges.push({ a, b, score: value.score })
      }
      edges.sort(
        (first, second) =>
          second.score - first.score || rank.get(first.a)! - rank.get(second.a)! || rank.get(first.b)! - rank.get(second.b)!,
      )

      const clusterOf = new Map<string, string[]>(linkedIds.map((id) => [id, [id]]))
      const isLinked = (a: string, b: string) => links.get(a)?.has(b) === true
      for (const { a, b } of edges) {
        const first = clusterOf.get(a)!
        const second = clusterOf.get(b)!
        if (first === second) continue
        if (!first.every((x) => second.every((y) => isLinked(x, y)))) continue
        const merged = [...first, ...second]
        for (const id of merged) clusterOf.set(id, merged)
      }

      const clusters = new Set([...clusterOf.values()].filter((cluster) => cluster.length > 1))
      return [...clusters].map((cluster) => {
        const photoIds = [...cluster].sort((first, second) => rank.get(first)! - rank.get(second)!)
        const allSame = photoIds.every((x, index) => photoIds.slice(index + 1).every((y) => links.get(x)!.get(y)!.kind === 'same'))
        return { kind: allSame ? 'same' : 'similar', photoIds }
      })
    },

    statusOf(id) {
      const entry = entries.get(id)
      if (!entry) return undefined
      if (!entry.prepared.comparable) return 'incomparable'
      return isCrowded(entry) ? 'crowded' : 'comparable'
    },

    get comparisonCount() {
      return comparisonCount
    },
  }
}
