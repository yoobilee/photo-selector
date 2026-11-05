import { decodeAnalysisImage, type CreateAnalysisContext, type SharpnessAnalysis } from './analyzeImageSharpness.ts'
import type { GrayImage, SharpnessResult } from './sharpness.ts'
import type { SharpnessWorkerRequest, SharpnessWorkerResponse } from './sharpness.worker.ts'

export interface SharpnessAnalyzer {
  analyze(file: Blob): Promise<SharpnessResult>
  // analyze와 같은 경로로 분석하고 판정에 쓴 측정값도 돌려준다(개발용 평가 도구).
  measure(file: Blob): Promise<SharpnessAnalysis>
  // 모든 Worker를 종료한다. 진행 중이던 분석은 실패로 끝난다.
  dispose(): void
}

export interface SharpnessAnalyzerOptions {
  // 없으면 분석을 지원하지 않는다.
  readonly createWorker?: (() => Worker) | null
  // Worker에서 OffscreenCanvas를 쓸 수 없으면 메인 스레드에서 디코딩·축소만 하고 계산은 Worker에 맡긴다.
  readonly prepareOnMainThread?: ((file: Blob) => Promise<GrayImage | null>) | null
  // Worker에 보낸 분석 한 장이 이 시간(ms) 안에 끝나지 않으면 그 Worker를 종료하고 분석 불가(timeout)로 끝낸다.
  readonly timeoutMs?: number
}

// 사진 한 장 분석의 기본 제한 시간. 느린 휴대폰에서 큰 사진을 디코딩하는 시간을 넉넉히 포함한다.
// 메인 스레드에서 디코딩하는 경로(prepareOnMainThread)는 디코딩을 중단할 수 없어 Worker로 보낸 뒤부터 잰다.
export const SHARPNESS_ANALYSIS_TIMEOUT_MS = 20_000

// 현재 브라우저에서 쓰는 분석 경로. 평가 결과에 기록해 브라우저별 차이를 구분한다.
export type AnalysisPath = 'worker' | 'main-thread-decode' | 'unsupported'

const FAILED: SharpnessAnalysis = { result: { status: 'unavailable', reason: 'failed' }, measurement: null }
const TIMED_OUT: SharpnessAnalysis = { result: { status: 'unavailable', reason: 'timeout' }, measurement: null }
const UNSUPPORTED: SharpnessAnalysis = { result: { status: 'unavailable', reason: 'unsupported' }, measurement: null }

// Vite가 같은 도메인의 별도 파일로 번들한다. 외부 CDN에서 불러오지 않는다.
const createDefaultWorker = () => new Worker(new URL('./sharpness.worker.ts', import.meta.url), { type: 'module' })

const createElementContext: CreateAnalysisContext = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.getContext('2d', { willReadFrequently: true })
}

export function getAnalysisPath(): AnalysisPath {
  if (typeof Worker === 'undefined') return 'unsupported'
  return typeof OffscreenCanvas === 'undefined' ? 'main-thread-decode' : 'worker'
}

const defaultOptions = (): SharpnessAnalyzerOptions => {
  const path = getAnalysisPath()
  return {
    createWorker: path === 'unsupported' ? null : createDefaultWorker,
    prepareOnMainThread: path === 'main-thread-decode' ? (file) => decodeAnalysisImage(file, createElementContext) : null,
  }
}

// 분석을 Web Worker로 보낸다. Worker는 처음 필요할 때 만들고 끝난 뒤 재사용하므로 동시에 만들어지는 수는
// 동시에 요청한 분석 수(호출하는 큐의 동시 실행 상한)를 넘지 않는다.
export function createSharpnessWorkerAnalyzer(options: SharpnessAnalyzerOptions = defaultOptions()): SharpnessAnalyzer {
  const { createWorker = null, prepareOnMainThread = null, timeoutMs = SHARPNESS_ANALYSIS_TIMEOUT_MS } = options
  const idle: Worker[] = []
  const workers = new Set<Worker>()
  const jobs = new Map<
    number,
    { worker: Worker; resolve: (analysis: SharpnessAnalysis) => void; timer: ReturnType<typeof setTimeout> | null }
  >()
  let lastJobId = 0
  let disposed = false

  // 불러오기 실패·비정상 종료·시간 초과한 Worker는 맡은 분석을 outcome으로 끝내고 버린다. 다음 분석은 새 Worker로 한다.
  // 다른 Worker가 진행 중인 분석은 그대로 둔다.
  const discard = (worker: Worker, outcome: SharpnessAnalysis = FAILED) => {
    for (const [jobId, job] of jobs) {
      if (job.worker !== worker) continue
      jobs.delete(jobId)
      if (job.timer !== null) clearTimeout(job.timer)
      job.resolve(outcome)
    }
    workers.delete(worker)
    const idleIndex = idle.indexOf(worker)
    if (idleIndex !== -1) idle.splice(idleIndex, 1)
    worker.terminate()
  }

  const acquire = (create: () => Worker): Worker => {
    const reusable = idle.pop()
    if (reusable) return reusable
    const worker = create()
    workers.add(worker)
    worker.addEventListener('message', (event: MessageEvent<SharpnessWorkerResponse>) => {
      const job = jobs.get(event.data.jobId)
      if (!job) return
      jobs.delete(event.data.jobId)
      if (job.timer !== null) clearTimeout(job.timer)
      if (!disposed) idle.push(worker)
      job.resolve({ result: event.data.result, measurement: event.data.measurement ?? null })
    })
    worker.addEventListener('error', () => discard(worker))
    worker.addEventListener('messageerror', () => discard(worker))
    return worker
  }

  const send = (create: () => Worker, request: SharpnessWorkerRequest, transfer: Transferable[]) => {
    let worker: Worker
    try {
      worker = acquire(create)
    } catch {
      return Promise.resolve(FAILED)
    }
    return new Promise<SharpnessAnalysis>((resolve) => {
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => discard(worker, TIMED_OUT), timeoutMs) : null
      jobs.set(request.jobId, { worker, resolve, timer })
      try {
        worker.postMessage(request, transfer)
      } catch {
        if (timer !== null) clearTimeout(timer)
        jobs.delete(request.jobId)
        idle.push(worker)
        resolve(FAILED)
      }
    })
  }

  const measure = async (file: Blob): Promise<SharpnessAnalysis> => {
    if (disposed) return FAILED
    if (!createWorker) return UNSUPPORTED
    lastJobId += 1
    const jobId = lastJobId
    if (!prepareOnMainThread) return send(createWorker, { jobId, kind: 'file', file }, [])

    let image: GrayImage | null
    try {
      image = await prepareOnMainThread(file)
    } catch {
      return FAILED
    }
    if (disposed) return FAILED
    // 분석용 화소 버퍼는 복사하지 않고 Worker로 넘긴다.
    return send(createWorker, { jobId, kind: 'pixels', image }, image ? [image.pixels.buffer] : [])
  }

  return {
    analyze: async (file) => (await measure(file)).result,
    measure,
    dispose() {
      disposed = true
      for (const worker of workers) worker.terminate()
      workers.clear()
      idle.length = 0
      for (const job of jobs.values()) {
        if (job.timer !== null) clearTimeout(job.timer)
        job.resolve(FAILED)
      }
      jobs.clear()
    },
  }
}
