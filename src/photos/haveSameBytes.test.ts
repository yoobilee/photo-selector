import { describe, expect, it } from 'vitest'
import { haveSameBytes } from './haveSameBytes.ts'

const blobOf = (...bytes: number[]) => new Blob([new Uint8Array(bytes)])

describe('haveSameBytes', () => {
  it('returns true only for identical content', async () => {
    await expect(haveSameBytes(blobOf(1, 2, 3), blobOf(1, 2, 3))).resolves.toBe(true)
    await expect(haveSameBytes(blobOf(1, 2, 3), blobOf(1, 2, 4))).resolves.toBe(false)
    await expect(haveSameBytes(blobOf(1, 2, 3), blobOf(1, 2))).resolves.toBe(false)
  })

  it('compares every chunk when content is read in parts', async () => {
    await expect(haveSameBytes(blobOf(1, 2, 3, 4, 5), blobOf(1, 2, 3, 4, 5), 2)).resolves.toBe(true)
    await expect(haveSameBytes(blobOf(1, 2, 3, 4, 5), blobOf(1, 2, 3, 4, 9), 2)).resolves.toBe(false)
  })

  it('treats empty files as identical', async () => {
    await expect(haveSameBytes(blobOf(), blobOf())).resolves.toBe(true)
  })
})
