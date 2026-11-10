// runInBrowser.mjs가 저장한 분석용 밝기 이미지(1/256 고정소수점 Uint16 + 크기 JSON)를 GrayImage로 읽는다. 없으면 null이다.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function loadCachedImage(cacheDir, id) {
  const path = join(cacheDir, `${id}.u16`)
  let meta
  try {
    meta = JSON.parse(await readFile(`${path}.json`, 'utf8'))
  } catch {
    return null
  }
  const bytes = await readFile(path)
  const fixed = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const pixels = new Float32Array(fixed.length)
  for (let index = 0; index < fixed.length; index += 1) pixels[index] = fixed[index] / 256
  return { width: meta.width, height: meta.height, pixels }
}
