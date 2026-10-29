import { describe, expect, it, vi } from 'vitest'
import type { GrayImage, SharpnessResult } from './sharpness.ts'
import type { SharpnessWorkerRequest } from './sharpness.worker.ts'
import { createSharpnessWorkerAnalyzer } from './sharpnessWorkerClient.ts'

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

    workers[0]!.respond(0, { status: 'blurry' })
    workers[1]!.respond(0, { status: 'sharp' })
    await expect(first).resolves.toEqual({ status: 'blurry' })
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

  it('reports analysis as unsupported without Web Worker', async () => {
    const analyzer = createSharpnessWorkerAnalyzer({ createWorker: null })
    await expect(analyzer.analyze(photo)).resolves.toEqual({ status: 'unavailable', reason: 'unsupported' })
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
