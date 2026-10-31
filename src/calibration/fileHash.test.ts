import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBytes } from '../test/imageFiles.ts'
import { sha256Hex } from './fileHash.ts'

describe('sha256Hex', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hashes the exact file bytes as lowercase hex and leaves the file unchanged', async () => {
    const file = new File([new Uint8Array([0x61, 0x62, 0x63])], 'abc.jpg', { type: 'image/jpeg' })
    expect(await sha256Hex(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await readBytes(file)).toEqual([0x61, 0x62, 0x63])
  })

  it('depends on the content, not the file name', async () => {
    const first = await sha256Hex(new File([new Uint8Array([1, 2, 3])], 'same.jpg'))
    expect(await sha256Hex(new File([new Uint8Array([1, 2, 3])], 'other.jpg'))).toBe(first)
    expect(await sha256Hex(new File([new Uint8Array([1, 2, 4])], 'same.jpg'))).not.toBe(first)
  })

  it('fails instead of guessing when Web Crypto is unavailable or the file cannot be read', async () => {
    const unreadable = new Blob(['x'])
    unreadable.arrayBuffer = () => Promise.reject(new Error('NotReadableError'))
    await expect(sha256Hex(unreadable)).rejects.toThrow('NotReadableError')

    // 보안 컨텍스트가 아닌 주소(예: http://192.168.x.x)에서는 crypto.subtle이 없다.
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    await expect(sha256Hex(new Blob(['x']))).rejects.toThrow('Web Crypto is unavailable')
  })
})
