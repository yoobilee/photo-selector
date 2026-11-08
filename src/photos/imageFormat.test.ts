import { describe, expect, it } from 'vitest'
import { createImageFile, createTextFile } from '../test/imageFiles.ts'
import { detectImageFormat, detectImageFormatFromBytes, IMAGE_INPUT_ACCEPT } from './imageFormat.ts'

// ISO 미디어 파일의 ftyp 상자를 만든다. 크기를 직접 주면 잘못된 상자도 만들 수 있다.
function ftypBox(major: string, compatible: string[], size = 16 + compatible.length * 4): Uint8Array {
  const text = (value: string) => [...value].map((character) => character.charCodeAt(0))
  return new Uint8Array([
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...text('ftyp'),
    ...text(major),
    0,
    0,
    0,
    0,
    ...compatible.flatMap(text),
  ])
}

describe('detectImageFormat', () => {
  it.each([
    ['jpeg', 'photo.jpg'],
    ['png', 'photo.png'],
    ['webp', 'photo.webp'],
    ['heif', 'photo.heic'],
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

  // 실제 HEIC 파일(e2e/fixtures/sunrise.heic)의 판별은 E2E가 실제 브라우저에서 확인한다.
  it('uses the HEIF brands rather than the file name or reported type', async () => {
    const heicNamedAsJpeg = new File([await createImageFile('x', 'heif').arrayBuffer()], 'photo.jpg', {
      type: 'image/jpeg',
    })
    await expect(detectImageFormat(heicNamedAsJpeg)).resolves.toBe('heif')
    await expect(detectImageFormat(new File([heicNamedAsJpeg], 'photo', { type: '' }))).resolves.toBe('heif')
  })

  it('treats a JPEG named .heic as JPEG', async () => {
    const jpegNamedAsHeic = new File([await createImageFile('x.jpg', 'jpeg').arrayBuffer()], 'IMG_0001.HEIC', {
      type: 'image/heic',
    })
    await expect(detectImageFormat(jpegNamedAsHeic)).resolves.toBe('jpeg')
  })

  it.each([
    ['iPhone HEIC', ftypBox('heic', ['mif1', 'MiHE', 'miaf', 'MiHB', 'heic'])],
    ['HEIC with extensions', ftypBox('heix', ['mif1', 'heix'])],
    ['HEIC sequence', ftypBox('hevc', ['msf1', 'hevc'])],
    ['generic HEIF', ftypBox('mif1', ['mif1', 'miaf'])],
  ])('recognizes %s as HEIF', (_, bytes) => {
    expect(detectImageFormatFromBytes(bytes)).toBe('heif')
  })

  it.each([
    ['AVIF', ftypBox('avif', ['mif1', 'miaf', 'MA1B'])],
    ['AVIF sequence', ftypBox('avis', ['msf1', 'avis'])],
    ['MP4 video', ftypBox('isom', ['isom', 'iso2', 'avc1', 'mp41'])],
    ['QuickTime video', ftypBox('qt  ', ['qt  '])],
    ['ftyp box smaller than its header', ftypBox('heic', [], 8)],
    ['truncated ftyp box', ftypBox('heic', []).subarray(0, 12)],
  ])('does not treat %s as HEIF', (_, bytes) => {
    expect(detectImageFormatFromBytes(bytes)).toBeNull()
  })

  it('reads only the compatible brands inside the ftyp box', () => {
    // 상자 크기가 16바이트면 뒤에 오는 heic는 다른 상자의 내용이다.
    const bytes = new Uint8Array([...ftypBox('isom', [], 16), ...[0x68, 0x65, 0x69, 0x63]])
    expect(detectImageFormatFromBytes(bytes)).toBeNull()
  })

  it('does not treat other RIFF containers as WebP', () => {
    const wave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    expect(detectImageFormatFromBytes(wave)).toBeNull()
  })
})

describe('IMAGE_INPUT_ACCEPT', () => {
  // Mac Safari는 accept에 MIME이 정확히 없는 형식의 이미지를 첫 형식(JPEG)으로 바꿔서 넘긴다.
  // HEIC를 정확히 적어야 원본 HEIC를 그대로 받는다.
  it('lists each supported format exactly so browsers hand over the original file', () => {
    const accepted = IMAGE_INPUT_ACCEPT.split(',')
    expect(accepted).toEqual(expect.arrayContaining(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']))
    expect(accepted).toEqual(expect.arrayContaining(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']))
    expect(accepted[0]).toBe('image/jpeg')
    expect(accepted.some((value) => value.includes('*'))).toBe(false)
  })
})
