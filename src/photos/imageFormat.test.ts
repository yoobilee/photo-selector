import { describe, expect, it } from 'vitest'
import { createImageFile, createTextFile } from '../test/imageFiles.ts'
import { detectImageFormat, detectImageFormatFromBytes } from './imageFormat.ts'

describe('detectImageFormat', () => {
  it.each([
    ['jpeg', 'photo.jpg'],
    ['png', 'photo.png'],
    ['webp', 'photo.webp'],
  ] as const)('recognizes %s by its file signature', async (format, name) => {
    await expect(detectImageFormat(createImageFile(name, format))).resolves.toBe(format)
  })

  it('uses the actual content instead of the file name or reported type', async () => {
    const pngNamedAsJpeg = new File([await createImageFile('x.png', 'png').arrayBuffer()], 'photo.jpg', {
      type: 'image/jpeg',
    })
    const textNamedAsJpeg = new File(['hello'], 'photo.jpg', { type: 'image/jpeg' })

    await expect(detectImageFormat(pngNamedAsJpeg)).resolves.toBe('png')
    await expect(detectImageFormat(textNamedAsJpeg)).resolves.toBeNull()
  })

  it('rejects unsupported image formats and non-image files', async () => {
    await expect(detectImageFormat(createImageFile('anim.gif', 'gif'))).resolves.toBeNull()
    await expect(detectImageFormat(createTextFile('notes.txt'))).resolves.toBeNull()
    await expect(detectImageFormat(new File([], 'empty.jpg'))).resolves.toBeNull()
  })

  it('does not treat other RIFF containers as WebP', () => {
    const wave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    expect(detectImageFormatFromBytes(wave)).toBeNull()
  })
})
