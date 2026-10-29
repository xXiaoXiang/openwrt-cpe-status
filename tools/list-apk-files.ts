// Reads the SDK's `apk adbdump` output, so the list describes the actual APK.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const metadataPath = process.argv[2] || 'build/sdk-test/aarch64_cortex-a53/package-metadata.yaml'
const raw = await readFile(metadataPath, 'utf8')
const field = (name: string) => raw.match(new RegExp('^  ' + name + ': (.+)$', 'm'))?.[1] || ''
const name = field('name'), version = field('version'), arch = field('arch')
if (!name || !version || !arch) throw new Error('Missing APK package metadata')
const directories = new Map<string, string[]>()
let directory = '', inPaths = false
for (const line of raw.split(/\r?\n/)) {
  if (/^paths:/.test(line)) { inPaths = true; continue }
  if (!inPaths) continue
  if (/^\S/.test(line)) break
  const dir = line.match(/^  - name: (.+)$/)
  if (dir) directory = '/' + dir[1]
  const file = line.match(/^      - name: (.+)$/)
  if (file) {
    if (!directory) throw new Error('APK file without a parent directory')
    const files = directories.get(directory) || []
    files.push(file[1]); directories.set(directory, files)
  }
}
const paths = [...directories].flatMap(([dir, files]) => files.map(file => dir + '/' + file))
if (!paths.length || new Set(paths).size !== paths.length) throw new Error('Empty or duplicate APK file list')
const output = process.argv[3] || `build/package-inventory/${name}-${version}-${arch}.md`
const report = [
  `# ${name} ${version} (${arch})`, '',
  `APK 内共 ${paths.length} 个文件，安装大小 ${Number(field('installed-size')).toLocaleString('en-US')} 字节。`, '',
  `清单来源：${metadataPath}（SDK apk adbdump）。`, '',
  '| 安装目录 | 文件数 |', '| --- | ---: |',
  ...[...directories].map(([dir, files]) => `| \`${dir}/\` | ${files.length} |`), '',
  ...[...directories].flatMap(([dir, files]) => [
    `## ${dir}/`, '', '```text', ...files.map(file => dir + '/' + file), '```', '',
  ]),
  '## 运行时文件', '',
  '以下由程序运行时创建，不属于 APK 安装清单：', '',
  '```text',
  '/etc/cpe-status/apn-overrides.json', '/etc/cpe-status/apn-database.json',
  '/etc/cpe-status/apn-database.json.managed', '/etc/cpe-status/euicc.json',
  '/etc/cpe-status/dualstack_toone.json',
  '/etc/cpe-status/wwan-original.json', '/etc/cpe-status/sms/', '/tmp/cpe-status/',
  '```', '',
  'lpac、adb、curl 等由独立软件包提供，不属于本 APK 的内置文件。', '',
].join('\n')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, report)
console.log(JSON.stringify({ version, arch, files: paths.length, report: output }))
