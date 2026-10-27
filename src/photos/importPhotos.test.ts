import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImageFile, createTextFile, readBytes } from '../test/imageFiles.ts'
import { installObjectUrlTracker } from '../test/objectUrls.ts'
import { importPhotos } from './importPhotos.ts'

// 실제 디코딩은 E2E에서 확인한다. 이름이 broken으로 시작하는 파일은 손상된 이미지처럼 디코딩에 실패한다.
const fakeCreateThumbnail = vi.fn(async (file: Blob) => {
  if (file instanceof File && file.name.startsWith('broken')) {
    throw new Error('decode failed')
  }
  return { blob: new Blob(['thumbnail']), width: 40, height: 30 }
})

describe('importPhotos', () => {
  let objectUrls: ReturnType<typeof installObjectUrlTracker>

  beforeEach(() => {
    objectUrls = installObjectUrlTracker()
    fakeCreateThumbnail.mockClear()
  })

  afterEach(() => {
    objectUrls.restore()
  })

  it('adds multiple supported photos in the selected order', async () => {
    const files = [
      createImageFile('a.jpg', 'jpeg', [1]),
      createImageFile('b.png', 'png', [2]),
      createImageFile('c.webp', 'webp', [3]),
    ]

    const result = await importPhotos(files, () => [], { createThumbnail: fakeCreateThumbnail })

    expect(result.skipped).toEqual([])
    expect(result.added.map((photo) => [photo.source.name, photo.format])).toEqual([
      ['a.jpg', 'jpeg'],
      ['b.png', 'png'],
      ['c.webp', 'webp'],
    ])
    expect(new Set(result.added.map((photo) => photo.id)).size).toBe(3)
    expect(result.added.every((photo) => objectUrls.liveUrls.has(photo.thumbnailUrl))).toBe(true)
  })

  it('keeps the original File object and its bytes unchanged', async () => {
    const original = createImageFile('original.jpg', 'jpeg', [10, 20, 30, 40])
    const bytesBefore = await readBytes(original)

    const result = await importPhotos([original], () => [], { createThumbnail: fakeCreateThumbnail })

    const photo = result.added[0]
    expect(photo?.source).toBe(original)
    expect(photo?.source.name).toBe('original.jpg')
    expect(photo?.source.type).toBe('image/jpeg')
    expect(photo?.source.size).toBe(bytesBefore.length)
    await expect(readBytes(original)).resolves.toEqual(bytesBefore)
    // 미리보기는 원본이 아닌 별도 Blob에서 만든다.
    expect(objectUrls.createObjectURL).not.toHaveBeenCalledWith(original)
  })

  it('skips unsupported formats without decoding them', async () => {
    const result = await importPhotos(
      [createImageFile('anim.gif', 'gif'), createTextFile('notes.jpg'), createImageFile('ok.jpg', 'jpeg')],
      () => [],
      { createThumbnail: fakeCreateThumbnail },
    )

    expect(result.added.map((photo) => photo.source.name)).toEqual(['ok.jpg'])
    expect(result.skipped).toEqual([
      { fileName: 'anim.gif', reason: 'unsupported-format' },
      { fileName: 'notes.jpg', reason: 'unsupported-format' },
    ])
    expect(fakeCreateThumbnail).toHaveBeenCalledTimes(1)
  })

  it('skips corrupted images and does not leave object URLs behind', async () => {
    const result = await importPhotos(
      [createImageFile('broken.jpg', 'jpeg', [9]), createImageFile('fine.png', 'png')],
      () => [],
      { createThumbnail: fakeCreateThumbnail },
    )

    expect(result.added.map((photo) => photo.source.name)).toEqual(['fine.png'])
    expect(result.skipped).toEqual([{ fileName: 'broken.jpg', reason: 'unreadable' }])
    expect(objectUrls.liveUrls.size).toBe(1)
  })

  it('skips files that cannot be read', async () => {
    const unreadable = createImageFile('gone.jpg', 'jpeg')
    vi.spyOn(unreadable, 'slice').mockImplementation(() => {
      throw new DOMException('File was removed', 'NotReadableError')
    })

    const result = await importPhotos([unreadable], () => [], { createThumbnail: fakeCreateThumbnail })

    expect(result.added).toEqual([])
    expect(result.skipped).toEqual([{ fileName: 'gone.jpg', reason: 'unreadable' }])
  })

  it('treats identical bytes as a duplicate regardless of the file name', async () => {
    const first = await importPhotos([createImageFile('a.jpg', 'jpeg', [1, 2])], () => [], {
      createThumbnail: fakeCreateThumbnail,
    })

    const second = await importPhotos(
      [
        createImageFile('a-copy.jpg', 'jpeg', [1, 2]),
        createImageFile('a.jpg', 'jpeg', [1, 3]),
        createImageFile('b.jpg', 'jpeg', [7, 7]),
        createImageFile('b-again.jpg', 'jpeg', [7, 7]),
      ],
      () => first.added,
      { createThumbnail: fakeCreateThumbnail },
    )

    expect(second.added.map((photo) => photo.source.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(second.skipped).toEqual([
      { fileName: 'a-copy.jpg', reason: 'duplicate' },
      { fileName: 'b-again.jpg', reason: 'duplicate' },
    ])
  })

  it('reads the current list for each file so photos removed during an import are not duplicates', async () => {
    const first = await importPhotos([createImageFile('a.jpg', 'jpeg', [1])], () => [], {
      createThumbnail: fakeCreateThumbnail,
    })
    let currentPhotos = first.added
    const removeExistingAfterFirst = vi.fn(async (file: Blob) => {
      currentPhotos = []
      return fakeCreateThumbnail(file)
    })

    const result = await importPhotos(
      [createImageFile('b.jpg', 'jpeg', [2]), createImageFile('a-copy.jpg', 'jpeg', [1])],
      () => currentPhotos,
      { createThumbnail: removeExistingAfterFirst },
    )

    expect(result.added.map((photo) => photo.source.name)).toEqual(['b.jpg', 'a-copy.jpg'])
    expect(result.skipped).toEqual([])
  })

  it('does not report a duplicate when the matching photo is removed during the byte comparison', async () => {
    const first = await importPhotos([createImageFile('a.jpg', 'jpeg', [1])], () => [], {
      createThumbnail: fakeCreateThumbnail,
    })
    const existing = first.added[0]
    if (!existing) throw new Error('setup failed')
    let currentPhotos = first.added
    // 기존 사진의 바이트를 읽기 시작하는 순간(비교 도중) 목록에서 제거한다.
    const readExisting = existing.source.slice.bind(existing.source)
    vi.spyOn(existing.source, 'slice').mockImplementation((...args) => {
      currentPhotos = []
      return readExisting(...args)
    })

    const result = await importPhotos([createImageFile('a-copy.jpg', 'jpeg', [1])], () => currentPhotos, {
      createThumbnail: fakeCreateThumbnail,
    })

    expect(result.added.map((photo) => photo.source.name)).toEqual(['a-copy.jpg'])
    expect(result.skipped).toEqual([])
  })

  it('reports progress for every file', async () => {
    const onProgress = vi.fn()

    await importPhotos([createImageFile('a.jpg', 'jpeg'), createTextFile('b.txt')], () => [], {
      createThumbnail: fakeCreateThumbnail,
      onProgress,
    })

    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('releases created previews and returns nothing when aborted', async () => {
    const controller = new AbortController()
    const abortAfterFirst = vi.fn(async (file: Blob) => {
      const thumbnail = await fakeCreateThumbnail(file)
      controller.abort()
      return thumbnail
    })

    const result = await importPhotos(
      [createImageFile('a.jpg', 'jpeg', [1]), createImageFile('b.jpg', 'jpeg', [2])],
      () => [],
      { createThumbnail: abortAfterFirst, signal: controller.signal },
    )

    expect(result).toEqual({ added: [], skipped: [] })
    expect(abortAfterFirst).toHaveBeenCalledTimes(1)
    expect(objectUrls.createObjectURL).toHaveBeenCalledTimes(1)
    expect(objectUrls.liveUrls.size).toBe(0)
  })
})
