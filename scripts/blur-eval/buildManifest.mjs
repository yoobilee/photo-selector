// 개발용 실제 사진 흐림 평가 목록(manifest)을 만든다. 사진 파일은 저장소 밖(사용자가 지정한 폴더)에만 두고 커밋하지 않는다.
//
// 지원 자료
// - Kwentar Blur Dataset(CC0): 같은 장면 350개를 휴대폰·카메라로 선명(S)·초점 흐림(F)·움직임 흐림(M) 세 장씩 촬영.
//   파일명 `번호_기기_종류.확장자`. 세 장은 화소 단위로 정렬되지 않는다.
// - RealBlur-J(CC BY 4.0, Rim et al. ECCV 2020): 같은 순간을 두 카메라로 찍은 실제 손 흔들림(blur)·선명(gt) 쌍.
//   카메라 JPEG에서 잘라 정렬한 PNG. 공식 train/test 장면 목록이 있으면 그대로 따른다.
//
// 개선용(dev)과 최종 검증용(holdout)은 장면 단위로 나눈다. 같은 장면의 선명·흐림 사진은 항상 같은 쪽에 있다.
// Kwentar는 장면 번호의 SHA-256으로 60:40 고정 분할한다(실행할 때마다 같다). RealBlur는 공식 train→dev, test→holdout.
//
// 사용: node scripts/blur-eval/buildManifest.mjs --out <manifest.json> [--kwentar <폴더>] [--realblur <폴더>]
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: { out: { type: 'string' }, kwentar: { type: 'string' }, realblur: { type: 'string' } },
})
if (!args.out) throw new Error('--out is required')

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

const DEV_SHARE = 0.6
function hashSplit(key) {
  const first = createHash('sha256').update(key).digest().readUInt32BE(0)
  return first / 2 ** 32 < DEV_SHARE ? 'dev' : 'holdout'
}

const contentTypeOf = (path) => (/\.png$/i.test(path) ? 'image/png' : 'image/jpeg')
const items = []

if (args.kwentar) {
  const kinds = { S: 'sharp', F: 'defocus', M: 'motion' }
  for await (const path of walk(args.kwentar)) {
    const match = /(?:^|[\\/])(\d+)_([^\\/]+)_([SFM])\.(jpe?g|png)$/i.exec(path)
    if (!match) continue
    const [, number, device, kind] = match
    const scene = `kwentar-${number}`
    items.push({
      id: `${scene}-${kinds[kind.toUpperCase()]}`,
      dataset: 'kwentar',
      scene,
      device,
      kind: kinds[kind.toUpperCase()],
      split: hashSplit(scene),
      path,
      contentType: contentTypeOf(path),
    })
  }
}

if (args.realblur) {
  // 공식 목록 파일: 한 줄에 `.../sceneNNN/gt/gt_k.png .../sceneNNN/blur/blur_k.png`
  const officialSplit = new Map()
  for await (const path of walk(args.realblur)) {
    const listMatch = /RealBlur_J_(train|test)_list\.txt$/i.exec(path)
    if (!listMatch) continue
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
      const scene = /scene(\d+)/.exec(line)?.[1]
      if (scene) officialSplit.set(scene, listMatch[1] === 'train' ? 'dev' : 'holdout')
    }
  }
  for await (const path of walk(args.realblur)) {
    const match = /RealBlur-J[^\\/]*[\\/]scene(\d+)[\\/](gt|blur)[\\/](?:gt|blur)_(\d+)\.png$/i.exec(path)
    if (!match) continue
    const [, number, folder, shot] = match
    const scene = `realblur-${number}`
    items.push({
      id: `${scene}-${folder === 'gt' ? 'sharp' : 'motion'}-${shot}`,
      dataset: 'realblur',
      scene,
      device: 'Sony A7R3',
      kind: folder === 'gt' ? 'sharp' : 'motion',
      split: officialSplit.get(number) ?? hashSplit(scene),
      splitSource: officialSplit.has(number) ? 'official' : 'hash',
      path,
      contentType: contentTypeOf(path),
    })
  }
}

items.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
const summary = {}
for (const item of items) {
  const key = `${item.dataset}/${item.split}/${item.kind}`
  summary[key] = (summary[key] ?? 0) + 1
}
await writeFile(
  args.out,
  // 경로는 이 기기에서만 의미가 있다. 평가 목록 파일도 커밋하지 않는다.
  JSON.stringify({ createdAt: new Date().toISOString(), devShare: DEV_SHARE, summary, items }, null, 1),
)
console.log(summary)
