import { getAnalysisSize, type GrayImage } from './sharpness.ts'

// 원본 RGBA 행을 띠 단위로 받아 분석용 밝기 이미지를 만든다. 브라우저 캔버스 축소를 쓰지 않으므로 디코딩된 화소가 같으면
// 어느 브라우저에서도 같은 결과가 나온다(docs/sharpness-browser-consistency.md).
//
// 판정 기준값은 기존 경로(캔버스로 줄여 8비트로 읽은 뒤 밝기 변환, 원본이 충분히 크면 2배 크기로 그린 뒤 2×2 평균)의
// 분석용 이미지로 정해졌다. 그래서 캔버스의 브라우저별 보간만 바꾸고 나머지 구조는 그대로 따른다.
//   1. 원본이 분석 크기의 2배 이상이면 2배 크기, 아니면 분석 크기를 중간 크기로 한다(기존 규칙).
//   2. 중간 크기로 RGB 채널별 면적 평균한다. 원본 화소가 중간 화소 경계에 걸치면 겹친 면적 비율로 나눈다.
//   3. 캔버스에서 읽은 값처럼 채널별로 0~255 정수로 반올림한 뒤 밝기(Rec. 601)로 바꾼다.
//   4. 중간 크기가 2배면 2×2 평균으로 분석 크기로 줄인다.
// 원본이 분석 크기 이하면 1~4는 기존 밝기 변환(toGrayscale)과 같은 값이다.
export interface AnalysisDownsampler {
  // 원본의 startRow행부터 rgba.length / (원본 폭 × 4)행을 넣는다. 행은 위에서부터 빠짐없이 차례로 넣어야 한다.
  addRows(rgba: Uint8ClampedArray, startRow: number): void
  // 모든 행을 넣은 뒤 결과를 만든다.
  finish(): GrayImage
}

interface AxisWeights {
  // 원본 칸 i가 처음 걸치는 중간 칸
  readonly first: Int32Array
  // 원본 칸 i의 면적 중 first 칸에 들어가는 비율. 나머지(1 - 비율)는 first + 1 칸에 들어간다.
  readonly share: Float64Array
}

// 한 축의 원본 칸이 중간 칸에 들어가는 비율. 축소만 하므로 원본 칸 하나는 중간 칸 최대 두 개에 걸친다.
function axisWeights(source: number, target: number): AxisWeights {
  const first = new Int32Array(source)
  const share = new Float64Array(source)
  for (let index = 0; index < source; index += 1) {
    // 중간 좌표로 바꾼 원본 칸 [index, index + 1)의 시작과 끝. 정수 곱을 먼저 해 나누므로 경계가 정수면 정확하다.
    const start = (index * target) / source
    const end = ((index + 1) * target) / source
    const cell = Math.min(target - 1, Math.floor(start))
    first[index] = cell
    share[index] = end <= cell + 1 || cell === target - 1 ? 1 : (cell + 1 - start) / (end - start)
  }
  return { first, share }
}

// 캔버스에서 읽은 값처럼 0~255 정수로 반올림한다. 면적 평균은 0 이상인 값의 가중 평균이고 비율의 합이 면적과 같아
// 부동소수 오차가 있어도 반올림 결과는 0~255 안에 있다(255.5 이상이 될 수 없다).
const toByte = Math.round

// 다 모인 중간 행(채널별 합)을 8비트 RGB로 반올림해 밝기로 바꾸고, 분석 크기 행(top부터)에 1/(factor²)씩 더한다.
function addMiddleRow(
  sums: Float64Array,
  width: number,
  area: number,
  factor: number,
  output: Float64Array,
  top: number,
  outputShare: number,
): void {
  for (let x = 0; x < width; x += 1) {
    const offset = x * 3
    const gray =
      0.299 * toByte(sums[offset]! / area) +
      0.587 * toByte(sums[offset + 1]! / area) +
      0.114 * toByte(sums[offset + 2]! / area)
    const index = top + (factor === 2 ? x >> 1 : x)
    output[index] = output[index]! + gray * outputShare
  }
}

interface ColumnLayout {
  // 중간 칸 수
  readonly cells: number
  // 중간 칸마다 온전히 들어가는 원본 열의 끝(제외)
  readonly fullColumnsEnd: Int32Array
  // 중간 칸의 마지막 원본 열이 다음 칸 경계에 걸치는지(1)
  readonly straddles: Uint8Array
  // 원본 열의 면적 중 처음 걸치는 칸에 들어가는 비율
  readonly shares: Float64Array
}

// 원본 한 행(RGBA, pixel부터)을 중간 칸별 채널 합으로 모아 현재 중간 행에 rowShare, 다음 중간 행에 rowRest 비율로 더한다.
// 행마다 부르는 작은 함수로 분리해 엔진이 반복문 전체를 최적화하게 한다(중첩 반복문 안쪽만 최적화되면 크게 느려진다).
function addSourceRow(
  rgba: Uint8ClampedArray,
  start: number,
  layout: ColumnLayout,
  currentSums: Float64Array,
  nextSums: Float64Array,
  rowShare: number,
  rowRest: number,
): void {
  const { cells, fullColumnsEnd, straddles, shares } = layout
  let x = 0
  let pixel = start
  // 앞 칸 경계에 걸친 열에서 이 칸으로 넘어온 몫
  let carryRed = 0
  let carryGreen = 0
  let carryBlue = 0
  for (let cell = 0; cell < cells; cell += 1) {
    let red = carryRed
    let green = carryGreen
    let blue = carryBlue
    // 온전히 들어가는 열은 그대로 더한다.
    for (const end = fullColumnsEnd[cell]!; x < end; x += 1, pixel += 4) {
      red += rgba[pixel]!
      green += rgba[pixel + 1]!
      blue += rgba[pixel + 2]!
    }
    carryRed = 0
    carryGreen = 0
    carryBlue = 0
    if (straddles[cell]) {
      const share = shares[x]!
      const rest = 1 - share
      red += rgba[pixel]! * share
      green += rgba[pixel + 1]! * share
      blue += rgba[pixel + 2]! * share
      carryRed = rgba[pixel]! * rest
      carryGreen = rgba[pixel + 1]! * rest
      carryBlue = rgba[pixel + 2]! * rest
      x += 1
      pixel += 4
    }
    const offset = cell * 3
    currentSums[offset] = currentSums[offset]! + red * rowShare
    currentSums[offset + 1] = currentSums[offset + 1]! + green * rowShare
    currentSums[offset + 2] = currentSums[offset + 2]! + blue * rowShare
    if (rowRest > 0) {
      nextSums[offset] = nextSums[offset]! + red * rowRest
      nextSums[offset + 1] = nextSums[offset + 1]! + green * rowRest
      nextSums[offset + 2] = nextSums[offset + 2]! + blue * rowRest
    }
  }
}

// 분석 크기는 기본으로 getAnalysisSize로 정한다(판정하기에 너무 작은 원본은 오류). analysisSize는 개발용 평가 도구가
// 다른 분석 크기를 비교할 때만 넘긴다.
export function createAnalysisDownsampler(
  sourceWidth: number,
  sourceHeight: number,
  analysisSize: { readonly width: number; readonly height: number } | null = getAnalysisSize(sourceWidth, sourceHeight),
): AnalysisDownsampler {
  if (!(Number.isInteger(sourceWidth) && Number.isInteger(sourceHeight) && sourceWidth > 0 && sourceHeight > 0)) {
    throw new Error('source size must be positive integers')
  }
  const size = analysisSize
  if (!size) throw new Error('source is too small to analyze')
  if (!(Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0)) {
    throw new Error('analysis size must be positive integers')
  }
  if (size.width > sourceWidth || size.height > sourceHeight) throw new Error('only downsampling is supported')
  const factor = sourceWidth >= size.width * 2 && sourceHeight >= size.height * 2 ? 2 : 1
  const middleWidth = size.width * factor
  const middleHeight = size.height * factor

  const columns = axisWeights(sourceWidth, middleWidth)
  const rows = axisWeights(sourceHeight, middleHeight)
  // 중간 칸마다 온전히 들어가는 원본 열의 끝(제외)과, 경계에 걸쳐 다음 칸에도 나눠 주는 열이 있는지.
  // 원본 열은 칸 순서대로 이어지고, 경계에 걸치는 열은 그 칸의 마지막 열이다.
  const fullColumnsEnd = new Int32Array(middleWidth)
  const straddles = new Uint8Array(middleWidth)
  for (let x = 0; x < sourceWidth; x += 1) {
    const cell = columns.first[x]!
    if (columns.share[x]! < 1) straddles[cell] = 1
    else fullColumnsEnd[cell] = x + 1
  }
  const columnLayout: ColumnLayout = { cells: middleWidth, fullColumnsEnd, straddles, shares: columns.share }
  // 중간 행 하나의 채널별 합. 원본 한 행은 중간 행 최대 두 개(current, current + 1)에 걸치므로 두 행만 번갈아 쓴다.
  const sumsLength = middleWidth * 3
  const evenRowSums = new Float64Array(sumsLength)
  const oddRowSums = new Float64Array(sumsLength)
  const rowSumsOf = (row: number) => (row & 1 ? oddRowSums : evenRowSums)
  const output = new Float64Array(size.width * size.height)
  const middleArea = (sourceWidth / middleWidth) * (sourceHeight / middleHeight)
  const outputShare = 1 / (factor * factor)
  let current = 0
  let nextRow = 0

  // 중간 행 하나가 다 모이면 8비트로 반올림해 밝기로 바꾸고 분석 크기 행에 더한다.
  const completeRow = () => {
    const finished = rowSumsOf(current)
    addMiddleRow(finished, middleWidth, middleArea, factor, output, Math.floor(current / factor) * size.width, outputShare)
    finished.fill(0)
    current += 1
  }

  return {
    addRows(rgba, startRow) {
      const rowLength = sourceWidth * 4
      if (rgba.length % rowLength !== 0) throw new Error('RGBA length is not a whole number of rows')
      if (startRow !== nextRow) throw new Error('rows must be added in order without gaps')
      const count = rgba.length / rowLength
      if (startRow + count > sourceHeight) throw new Error('too many rows')
      for (let local = 0; local < count; local += 1) {
        const y = startRow + local
        while (current < rows.first[y]!) completeRow()
        const rowShare = rows.share[y]!
        const rowRest = 1 - rowShare
        addSourceRow(rgba, local * rowLength, columnLayout, rowSumsOf(current), rowSumsOf(current + 1), rowShare, rowRest)
      }
      nextRow = startRow + count
    },
    finish() {
      if (nextRow !== sourceHeight) throw new Error('not all rows were added')
      while (current < middleHeight) completeRow()
      return { width: size.width, height: size.height, pixels: Float32Array.from(output) }
    },
  }
}
