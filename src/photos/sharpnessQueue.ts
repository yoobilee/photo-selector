import type { SharpnessResult } from './sharpness.ts'

// 동시에 분석하는 사진 수. 분석 한 장마다 원본 크기로 디코딩한 화소가 메모리에 잠시 올라간다.
export const SHARPNESS_CONCURRENCY = 2

export interface SharpnessQueue {
  // 같은 id가 이미 대기·진행 중이면 다시 넣지 않는다.
  enqueue(id: string, file: Blob, onResult: (result: SharpnessResult) => void): void
  // 대기 중이면 분석하지 않고, 진행 중이면 결과를 버린다.
  cancel(id: string): void
  has(id: string): boolean
  // 대기 중인 분석을 모두 버리고 이후 결과를 전달하지 않는다.
  dispose(): void
}

interface Job {
  readonly id: string
  readonly file: Blob
  readonly onResult: (result: SharpnessResult) => void
  cancelled: boolean
}

// 사진 순서대로 최대 concurrency장씩 분석한다. 한 장의 실패는 다른 사진의 분석을 멈추지 않는다.
export function createSharpnessQueue(
  analyze: (file: Blob) => Promise<SharpnessResult>,
  concurrency: number = SHARPNESS_CONCURRENCY,
): SharpnessQueue {
  const waiting: Job[] = []
  // 취소된 진행 중 분석도 끝날 때까지 동시 실행 수에 포함한다.
  const running = new Set<Job>()
  let disposed = false

  const start = (job: Job) => {
    running.add(job)
    // analyze가 동기적으로 예외를 던져도 같은 실패 경로로 처리한다.
    Promise.resolve()
      .then(() => analyze(job.file))
      .catch((): SharpnessResult => ({ status: 'unavailable', reason: 'failed' }))
      .then((result) => {
        running.delete(job)
        if (!job.cancelled && !disposed) job.onResult(result)
        pump()
      })
  }

  const pump = () => {
    while (!disposed && running.size < concurrency) {
      const job = waiting.shift()
      if (!job) return
      start(job)
    }
  }

  const find = (id: string) =>
    waiting.find((job) => job.id === id) ?? [...running].find((job) => job.id === id && !job.cancelled)

  return {
    enqueue(id, file, onResult) {
      if (disposed || find(id)) return
      waiting.push({ id, file, onResult, cancelled: false })
      pump()
    },
    cancel(id) {
      const index = waiting.findIndex((job) => job.id === id)
      if (index !== -1) waiting.splice(index, 1)
      for (const job of running) if (job.id === id) job.cancelled = true
    },
    has(id) {
      return find(id) !== undefined
    },
    dispose() {
      disposed = true
      waiting.length = 0
      for (const job of running) job.cancelled = true
    },
  }
}
