import { describe, expect, it, vi } from 'vitest'
import type { SharpnessResult } from './sharpness.ts'
import { createSharpnessQueue } from './sharpnessQueue.ts'

const SHARP: SharpnessResult = { status: 'sharp' }
const BLURRY: SharpnessResult = { status: 'blurry' }

// 호출 순서대로 끝낼 수 있는 가짜 분석기
function createControlledAnalyzer() {
  const calls: { file: Blob; finish: (result: SharpnessResult) => void; fail: (error: Error) => void }[] = []
  const analyze = vi.fn(
    (file: Blob) =>
      new Promise<SharpnessResult>((resolve, reject) => {
        calls.push({ file, finish: resolve, fail: reject })
      }),
  )
  return { analyze, calls }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const file = (name: string) => new File([name], name)

describe('createSharpnessQueue', () => {
  it('analyzes at most the concurrency limit at once, in order', async () => {
    const { analyze, calls } = createControlledAnalyzer()
    const queue = createSharpnessQueue(analyze, 2)
    const results: string[] = []
    for (const name of ['a', 'b', 'c', 'd']) queue.enqueue(name, file(name), (result) => results.push(`${name}:${result.status}`))
    await flush()

    expect(calls.map((call) => (call.file as File).name)).toEqual(['a', 'b'])
    calls[1]!.finish(BLURRY)
    await flush()
    expect(calls.map((call) => (call.file as File).name)).toEqual(['a', 'b', 'c'])
    calls[0]!.finish(SHARP)
    calls[2]!.finish(SHARP)
    await flush()
    calls[3]!.finish(SHARP)
    await flush()

    expect(results).toEqual(['b:blurry', 'a:sharp', 'c:sharp', 'd:sharp'])
    expect(analyze).toHaveBeenCalledTimes(4)
  })

  it('passes the original file object unchanged to the analyzer', async () => {
    const { analyze, calls } = createControlledAnalyzer()
    const queue = createSharpnessQueue(analyze, 1)
    const original = new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })
    queue.enqueue('a', original, () => {})
    await flush()

    expect(calls[0]!.file).toBe(original)
    calls[0]!.finish(SHARP)
    await flush()
    expect(Array.from(new Uint8Array(await original.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 1, 2, 3])
  })

  it('does not analyze the same photo twice while it is waiting or running', async () => {
    const { analyze, calls } = createControlledAnalyzer()
    const queue = createSharpnessQueue(analyze, 1)
    const onResult = vi.fn()
    queue.enqueue('a', file('a'), onResult)
    queue.enqueue('b', file('b'), onResult)
    queue.enqueue('a', file('a'), onResult)
    queue.enqueue('b', file('b'), onResult)
    await flush()

    expect(queue.has('a')).toBe(true)
    calls[0]!.finish(SHARP)
    await flush()
    calls[1]!.finish(SHARP)
    await flush()
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(2)
    expect(queue.has('a')).toBe(false)
  })

  it('skips a cancelled waiting photo and drops the result of a cancelled running photo', async () => {
    const { analyze, calls } = createControlledAnalyzer()
    const queue = createSharpnessQueue(analyze, 1)
    const onResult = vi.fn()
    queue.enqueue('running', file('running'), onResult)
    queue.enqueue('waiting', file('waiting'), onResult)
    queue.enqueue('next', file('next'), onResult)
    await flush()

    queue.cancel('waiting')
    queue.cancel('running')
    expect(queue.has('running')).toBe(false)
    calls[0]!.finish(BLURRY)
    await flush()

    expect(calls.map((call) => (call.file as File).name)).toEqual(['running', 'next'])
    calls[1]!.finish(SHARP)
    await flush()
    expect(onResult.mock.calls).toEqual([[SHARP]])
  })

  it('reports a failed analysis as unavailable and keeps analyzing the other photos', async () => {
    const queue = createSharpnessQueue(async (blob) => {
      if ((blob as File).name === 'broken') throw new Error('decode failed')
      if ((blob as File).name === 'throws') return Promise.reject(new Error('worker crashed'))
      return SHARP
    }, 2)
    const results = new Map<string, SharpnessResult>()
    for (const name of ['broken', 'ok', 'throws', 'ok2']) queue.enqueue(name, file(name), (result) => results.set(name, result))
    await vi.waitFor(() => expect(results.size).toBe(4))

    expect(results.get('broken')).toEqual({ status: 'unavailable', reason: 'failed' })
    expect(results.get('throws')).toEqual({ status: 'unavailable', reason: 'failed' })
    expect(results.get('ok')).toEqual(SHARP)
    expect(results.get('ok2')).toEqual(SHARP)
  })

  it('handles an analyzer that throws synchronously', async () => {
    const queue = createSharpnessQueue(() => {
      throw new Error('no worker')
    })
    const onResult = vi.fn()
    queue.enqueue('a', file('a'), onResult)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'unavailable', reason: 'failed' }))
  })

  it('stops delivering results and starting work after dispose', async () => {
    const { analyze, calls } = createControlledAnalyzer()
    const queue = createSharpnessQueue(analyze, 1)
    const onResult = vi.fn()
    queue.enqueue('a', file('a'), onResult)
    queue.enqueue('b', file('b'), onResult)
    await flush()

    queue.dispose()
    calls[0]!.finish(SHARP)
    await flush()
    queue.enqueue('c', file('c'), onResult)
    await flush()

    expect(analyze).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()
  })
})
