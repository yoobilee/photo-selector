const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024

// 두 파일의 바이트가 완전히 같은지 비교한다. 큰 사진도 메모리에 한 번에 올리지 않도록 나눠 읽고 차이가 보이면 바로 끝낸다.
export async function haveSameBytes(
  first: Blob,
  second: Blob,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Promise<boolean> {
  if (first.size !== second.size) return false

  for (let offset = 0; offset < first.size; offset += chunkBytes) {
    const end = offset + chunkBytes
    const [firstChunk, secondChunk] = await Promise.all([
      first.slice(offset, end).arrayBuffer(),
      second.slice(offset, end).arrayBuffer(),
    ])
    const firstBytes = new Uint8Array(firstChunk)
    const secondBytes = new Uint8Array(secondChunk)
    if (firstBytes.length !== secondBytes.length) return false
    for (let index = 0; index < firstBytes.length; index += 1) {
      if (firstBytes[index] !== secondBytes[index]) return false
    }
  }

  return true
}
