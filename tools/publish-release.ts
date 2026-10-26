import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'

const version = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: publish-release.ts vX.Y.Z')
const apkPath = `build/sdk-test/luci-app-cpe-status-${version.slice(1)}-r0.apk`
const apk = await readFile(apkPath)
const hash = createHash('sha256').update(apk).digest('hex')
const credential = execFileSync('git', ['credential','fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true })
const token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9)
if (!token) throw new Error('GitHub credential unavailable')
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
const endpoint = 'https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/releases'
let response = await fetch(`${endpoint}/tags/${version}`, { headers })
let release: { id: number; upload_url: string; html_url: string }
if (response.status === 404) {
  const body = version === 'v0.3.0' ? '首个独立公开版本，包含五个 LuCI 标签。静态资源位于 /www/luci-static/resources/cpe-status/，升级清理旧 openwrt-modem 静态目录。' : '模块配置驱动架构：按 AT 串口 USB VID/PID 选择 /etc/cpe-status/modem.d/*.conf，配置命令、参数及提取规则。新增可编辑 APN 扩展 /etc/cpe-status/apns.local.json。保留原五标签与缓存、实际回读行为。'
  response = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify({ tag_name: version, name: `CPE Status ${version}`, body: `${body}\n\nImmortalWrt 25.12.2 / aarch64_cortex-a53 APK\n\nSHA256: \`${hash}\`` }) })
}
if (!response.ok) throw new Error(`GitHub release failed: ${response.status}`)
release = await response.json() as typeof release
const assets = await fetch(`${endpoint}/${release.id}/assets`, { headers })
if (!assets.ok) throw new Error(`Cannot list release assets: ${assets.status}`)
const existing = await assets.json() as { name: string }[]
if (!existing.some(asset => asset.name === basename(apkPath))) {
  const upload = await fetch(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(basename(apkPath)), { method:'POST', headers: { ...headers, 'Content-Type':'application/octet-stream' }, body: apk })
  if (!upload.ok) throw new Error(`APK upload failed: ${upload.status}`)
}
console.log(JSON.stringify({ release: release.html_url, apk: basename(apkPath), sha256: hash }))
