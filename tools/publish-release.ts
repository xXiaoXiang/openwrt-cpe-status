import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { packageManifest, packageRelease } from '../project.ts'
import { sdkTargets, sdkArchitecture, apkFilename, type SdkArchitecture } from './sdk-targets.ts'

const version = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: publish-release.ts vX.Y.Z [notes-file|-] [aarch64_cortex-a53|x86_64|all]')
const revision = version.slice(1) === packageManifest.version ? packageRelease : 0
const architectures = process.argv[4] === 'all' ? Object.keys(sdkTargets) as SdkArchitecture[] : [sdkArchitecture(process.argv[4])]
const apks = await Promise.all(architectures.map(async architecture => {
  const name = apkFilename(version.slice(1), revision, architecture)
  const path = `build/sdk-test/${architecture}/${name}`
  const apk = await readFile(path)
  const metadata = await readFile(`build/sdk-test/${architecture}/package-metadata.yaml`, 'utf8')
  if (!metadata.includes(`\n  arch: ${architecture}\n`) || !metadata.includes(`\n  version: ${version.slice(1)}-r${revision}\n`)) throw new Error('APK metadata does not match release: ' + path)
  return { architecture, name, apk, hash: createHash('sha256').update(apk).digest('hex') }
}))
const credential = execFileSync('git', ['credential','fill'], { input: 'protocol=https\nhost=github.com\n\n', cwd: homedir(), encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true })
const token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9)
if (!token) throw new Error('GitHub credential unavailable')
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }
const endpoint = 'https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/releases'
const notes = process.argv[3] && process.argv[3] !== '-' ? (await readFile(process.argv[3], 'utf8')).trim() : undefined
let response = await fetch(`${endpoint}/tags/${version}`, { headers })
let release: { id: number; upload_url: string; html_url: string; body: string }
if (response.status === 404) {
  const tag = await fetch(`https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/git/ref/tags/${version}`, { headers })
  if (!tag.ok) throw new Error(`Push the release tag first: ${tag.status}`)
  response = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify({ tag_name: version, name: `CPE Status ${version}`, body: notes || '发布说明和模块适配、安装及配置方法见仓库 README.md 与 DEV.md。' }) })
}
if (!response.ok) throw new Error(`GitHub release failed: ${response.status}`)
release = await response.json() as typeof release
const assets = await fetch(`${endpoint}/${release.id}/assets`, { headers })
if (!assets.ok) throw new Error(`Cannot list release assets: ${assets.status}`)
interface ReleaseAsset { id: number; name: string; digest?: string; browser_download_url: string }
const existing = await assets.json() as ReleaseAsset[]
async function verify(asset: ReleaseAsset, expected: string) {
  let digest = asset.digest
  if (!digest) {
    const download = await fetch(asset.browser_download_url)
    if (!download.ok) throw new Error(`Cannot verify existing asset: ${download.status}`)
    digest = 'sha256:' + createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex')
  }
  if (digest !== 'sha256:' + expected) throw new Error('Existing release asset checksum mismatch: ' + asset.name)
}
for (const item of apks) {
  const current = existing.find(asset => asset.name === item.name)
  if (current) { await verify(current, item.hash); continue }
  const legacy = item.architecture === 'aarch64_cortex-a53' ? existing.find(asset => asset.name === `luci-app-cpe-status-${version.slice(1)}-r${revision}.apk`) : undefined
  if (legacy) {
    await verify(legacy, item.hash)
    const renamed = await fetch(`${endpoint}/assets/${legacy.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: item.name }) })
    if (!renamed.ok) throw new Error(`APK rename failed: ${renamed.status}`)
    continue
  }
  const upload = await fetch(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(item.name), { method:'POST', headers: { ...headers, 'Content-Type':'application/octet-stream' }, body: item.apk })
  if (!upload.ok) throw new Error(`APK upload failed: ${upload.status}`)
}
const finalAssets = await fetch(`${endpoint}/${release.id}/assets`, { headers })
if (!finalAssets.ok) throw new Error(`Cannot verify release assets: ${finalAssets.status}`)
const published = await finalAssets.json() as ReleaseAsset[]
for (const item of apks) {
  const asset = published.find(value => value.name === item.name)
  if (!asset) throw new Error('Uploaded APK is missing: ' + item.name)
  await verify(asset, item.hash)
}
const rows = published.filter(asset => /-(aarch64_cortex-a53|x86_64)\.apk$/.test(asset.name)).map(asset => {
  const architecture = /-(aarch64_cortex-a53|x86_64)\.apk$/.exec(asset.name)![1]
  const hash = asset.digest?.replace(/^sha256:/, '') || apks.find(item => item.name === asset.name)?.hash || '-'
  return `| ${architecture} | [${asset.name}](${asset.browser_download_url}) | \`${hash}\` |`
})
const intro = notes ?? release.body.split('\n\nImmortalWrt 25.12.2')[0]
const verification = published.some(asset => asset.name.endsWith('-x86_64.apk')) ? '\n\nx86_64 包已完成 SDK 构建及包完整性、架构和依赖检查，尚未进行 x86 路由器实机验证。' : ''
const updated = await fetch(`${endpoint}/${release.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: `${intro}\n\nImmortalWrt 25.12.2 APK\n\n| 架构 | 下载 | SHA256 |\n| --- | --- | --- |\n${rows.join('\n')}${verification}` }) })
if (!updated.ok) throw new Error(`Release notes update failed: ${updated.status}`)
console.log(JSON.stringify({ release: release.html_url, artifacts: apks.map(({name,hash}) => ({ name, sha256: hash })) }))
