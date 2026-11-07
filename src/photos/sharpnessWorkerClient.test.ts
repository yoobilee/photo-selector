import { describe, expect, it, vi } from 'vitest'
import type { GrayImage, SharpnessResult } from './sharpness.ts'
import type { SharpnessWorkerRequest } from './sharpness.worker.ts'
import { SHARPNESS_ANALYSIS_TIMEOUT_MS, createSharpnessWorkerAnalyzer } from './sharpnessWorkerClient.ts'
import { createMeasurement } from '../test/measurements.ts'
import { renderScene } from '../test/syntheticImages.ts'
import { createPhotoFingerprint } from './photoFingerprint.ts'

// jsdom에는 Web Worker가 없으므로 메시지 주고받기만 흉내 내는 가짜 Worker를 쓴다.
class FakeWorker extends EventTarget {
  readonly requests: { request: SharpnessWorkerRequest; transfer: Transferable[] }[] = []
  terminated = false

  postMessage(request: SharpnessWorkerRequest, transfer: Transferable[] = []) {
    this.requests.push({ request, transfer })
  }

  terminate() {
    this.terminated = true
  }

  respond(index: number, result: SharpnessResult) {
    this.dispatchEvent(new MessageEvent('message', { data: { jobId: this.requests[index]!.request.jobId, result } }))
  }

  crash() {
    this.dispatchEvent(new Event('error'))
  }
}

function createWorkers() {
  const workers: FakeWorker[] = []
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  return { workers, createWorker }
}

const photo = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })

describe('createSharpnessWorkerAnalyzer', () => {
  it('sends the original file to a worker and reuses idle workers', async () => {
    const { workers, createWorker } = createWorkers()
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker })

    const first = analyzer.analyze(photo)
    const second = analyzer.analyze(photo)
    expect(workers).toHaveLength(2)
    expect(workers[0]!.requests[0]!.request).toMatchObject({ kind: 'file', file: photo })

    workers[0]!.respond(0, { status: 'blurry', cause: 'unknown' })
    workers[1]!.respond(0, { status: 'sharp' })
    await expect(first).resolves.toEqual({ status: 'blurry', cause: 'unknown' })
    await expect(second).resolves.toEqual({ status: 'sharp' })

    const third = analyzer.analyze(photo)
    expect(createWorker).toHaveBeenCalledTimes(2)
    workers[1]!.respond(1, { status: 'sharp' })
    await expect(third).resolves.toEqual({ status: 'sharp' })
  })

  it('fails only the crashed worker job and uses a new worker afterwards', async () => {
    const { workers, createWorker } = createWorkers()
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker })

    const crashed = analyzer.analyze(photo)
    workers[0]!.crash()
    await expect(crashed).resolves.toEqual({ status: 'unavailable', reason: 'failed' })
    expect(workers[0]!.terminated).toBe(true)

    const next = analyzer.analyze(photo)
    expect(workers).toHaveLength(2)
    workers[1]!.respond(0, { status: 'sharp' })
    await expect(next).resolves.toEqual({ status: 'sharp' })
  })

  it('stops a stuck analysis after the time limit, replaces only that worker and keeps analyzing other photos', async () => {
    vi.useFakeTimers()
    try {
      const { workers, createWorker } = createWorkers()
      const analyzer = createSharpnessWorkerAnalyzer({ createWorker, timeoutMs: 1000 })

      const stuck = analyzer.analyze(photo)
      const other = analyzer.analyze(photo)
      vi.advanceTimersByTime(600)
      workers[1]!.respond(0, { status: 'sharp' })
      await expect(other).resolves.toEqual({ status: 'sharp' })

      vi.advanceTimersByTime(400)
      await expect(stuck).resolves.toEqual({ status: 'unavailable', reason: 'timeout' })
      expect(workers[0]!.terminated).toBe(true)
      expect(workers[1]!.terminated).toBe(false)
      // 시간 초과 뒤 늦게 온 응답은 무시한다.
      workers[0]!.respond(0, { status: 'blurry', cause: 'unknown' })

      // 끝난 분석의 제한 시간은 해제되므로 재사용한 Worker의 다음 분석을 끊지 않는다.
      const reused = analyzer.analyze(photo)
      const replacement = analyzer.analyze(photo)
      expect(workers).toHaveLength(3)
      vi.advanceTimersByTime(999)
      workers[1]!.respond(1, { status: 'sharp' })
      workers[2]!.respond(0, { status: 'blurry', cause: 'shake' })
      await expect(reused).resolves.toEqual({ status: 'sharp' })
      await expect(replacement).resolves.toEqual({ status: 'blurry', cause: 'shake' })
      expect(workers[1]!.terminated).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies a default time limit to every analysis', async () => {
    vi.useFakeTimers()
    try {
      const { workers, createWorker } = createWorkers()
      const analyzer = createSharpnessWorkerAnalyzer({ createWorker })
      const pending = analyzer.analyze(photo)
      vi.advanceTimersByTime(SHARPNESS_ANALYSIS_TIMEOUT_MS - 1)
      expect(workers[0]!.terminated).toBe(false)
      vi.advanceTimersByTime(1)
      await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' })
      expect(workers[0]!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the measurement from the same worker analysis for the evaluation tool', async () => {
    const { workers, createWorker } = createWorkers()
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker })
    const measurement = createMeasurement({ score: 0.0123, hasUnjudgedDirection: false, noise: 0.4 })

    const measured = analyzer.measure(photo)
    const verdictOnly = analyzer.analyze(photo)
    workers[0]!.dispatchEvent(
      new MessageEvent('message', { data: { jobId: workers[0]!.requests[0]!.request.jobId, result: { status: 'blurry', cause: 'unknown' }, measurement } }),
    )
    workers[1]!.dispatchEvent(
      new MessageEvent('message', { data: { jobId: workers[1]!.requests[0]!.request.jobId, result: { status: 'blurry', cause: 'unknown' }, measurement } }),
    )

    await expect(measured).resolves.toEqual({ result: { status: 'blurry', cause: 'unknown' }, measurement })
    await expect(verdictOnly).resolves.toEqual({ status: 'blurry', cause: 'unknown' })
    // 측정값이 없는 응답(이전 Worker 등)도 실패로 보지 않고 측정값만 비운다.
    const withoutMeasurement = analyzer.measure(photo)
    workers[1]!.respond(1, { status: 'sharp' })
    await expect(withoutMeasurement).resolves.toEqual({ result: { status: 'sharp' }, measurement: null })
  })

  it('returns the blur verdict and the similarity fingerprint from one worker analysis', async () => {
    const { workers, createWorker } = createWorkers()
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker })
    const fingerprint = createPhotoFingerprint(renderScene(128, 96, 1))!
    const reply = (worker: FakeWorker, index: number, data: object) =>
      worker.dispatchEvent(new MessageEvent('message', { data: { jobId: worker.requests[index]!.request.jobId, ...data } }))

    const analyzed = analyzer.analyzePhoto(photo)
    const malformed = analyzer.analyzePhoto(photo)
    reply(workers[0]!, 0, { result: { status: 'sharp' }, measurement: null, fingerprint })
    // 형식이 맞지 않는 지문은 쓰지 않는다. 흐림 판정은 그대로 쓴다.
    reply(workers[1]!, 0, { result: { status: 'blurry', cause: 'shake' }, measurement: null, fingerprint: { ...fingerprint, pixels: [1, 2] } })

    await expect(analyzed).resolves.toEqual({ sharpness: { status: 'sharp' }, fingerprint })
    await expect(malformed).resolves.toEqual({ sharpness: { status: 'blurry', cause: 'shake' }, fingerprint: null })
    // 평가 도구의 측정 결과에는 지문을 섞지 않는다.
    const measured = analyzer.measure(photo)
    reply(workers[1]!, 1, { result: { status: 'sharp' }, measurement: null, fingerprint })
    await expect(measured).resolves.toEqual({ result: { status: 'sharp' }, measurement: null })
  })

  it('leaves the fingerprint empty when the analysis fails, crashes or times out', async () => {
    vi.useFakeTimers()
    try {
      const { workers, createWorker } = createWorkers()
      const analyzer = createSharpnessWorkerAnalyzer({ createWorker, timeoutMs: 1000 })
      const crashed = analyzer.analyzePhoto(photo)
      workers[0]!.crash()
      await expect(crashed).resolves.toEqual({ sharpness: { status: 'unavailable', reason: 'failed' }, fingerprint: null })

      const stuck = analyzer.analyzePhoto(photo)
      vi.advanceTimersByTime(1000)
      await expect(stuck).resolves.toEqual({ sharpness: { status: 'unavailable', reason: 'timeout' }, fingerprint: null })
    } finally {
      vi.useRealTimers()
    }
    const unsupported = createSharpnessWorkerAnalyzer({ createWorker: null })
    await expect(unsupported.analyzePhoto(photo)).resolves.toEqual({
      sharpness: { status: 'unavailable', reason: 'unsupported' },
      fingerprint: null,
    })
  })

  it('reports analysis as unsupported without Web Worker', async () => {
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker: null })
    await expect(analyzer.analyze(photo)).resolves.toEqual({ status: 'unavailable', reason: 'unsupported' })
    await expect(analyzer.measure(photo)).resolves.toEqual({
      result: { status: 'unavailable', reason: 'unsupported' },
      measurement: null,
    })
  })

  it('terminates every worker on dispose and settles pending analyses', async () => {
    const { workers, createWorker } = createWorkers()
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker })
    const pending = analyzer.analyze(photo)

    analyzer.dispose()

    expect(workers.every((worker) => worker.terminated)).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'failed' })
    await expect(analyzer.analyze(photo)).resolves.toEqual({ status: 'unavailable', reason: 'failed' })
    expect(createWorker).toHaveBeenCalledTimes(1)
  })

  it('without OffscreenCanvas, prepares pixels on the main thread and transfers them instead of copying', async () => {
    const { workers, createWorker } = createWorkers()
    const image: GrayImage = { width: 2, height: 2, pixels: new Float32Array(4) }
    const prepareOnMainThread = vi.fn(async () => image)
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker, prepareOnMainThread })

    const result = analyzer.analyze(photo)
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1))

    expect(prepareOnMainThread).toHaveBeenCalledWith(photo)
    const { request, transfer } = workers[0]!.requests[0]!
    expect(request).toMatchObject({ kind: 'pixels', image })
    expect(transfer).toEqual([image.pixels.buffer])
    workers[0]!.respond(0, { status: 'sharp' })
    await expect(result).resolves.toEqual({ status: 'sharp' })
  })

  it('treats a main-thread decoding failure as unavailable, not blurry', async () => {
    const { workers, createWorker } = createWorkers()
    const analyzer = createSharpnessWorkerAnalyzer({
      createWorker,
      prepareOnMainThread: async () => {
        throw new Error('decode failed')
      },
    })

    await expect(analyzer.analyze(photo)).resolves.toEqual({ status: 'unavailable', reason: 'failed' })
    expect(workers).toHaveLength(0)
  })
})
