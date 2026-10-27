import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { sdkArchitecture, sdkTargets, apkFilename } from './sdk-targets.ts'

// SDK is downloaded and SHA-256 verified on this Ubuntu host, never on the router.
const host = 'baron@baron-omen.bulan'
const architecture = sdkArchitecture(process.argv[3])
const root = sdkTargets[architecture].root
const destination = resolve('build/sdk-test', architecture)
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', `UserKnownHostsFile=${homedir()}/.ssh/known_hosts`]
const action = process.argv[2] ?? 'status'
async function run(binary: string, args: string[], input?: string) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.end(input)
  await new Promise<void>((done, fail) => {
    child.on('error', fail)
    child.on('close', code => code === 0 ? done() : fail(new Error(`${binary} exited ${code}`)))
  })
}
const ssh = (script: string) => run('ssh', [...sshOptions, host, 'sh -s'], script + '\n')
if (action === 'start') {
  const recipe = await readFile('build/openwrt-status-package/Makefile', 'utf8')
  const version = /^PKG_VERSION:=([0-9.]+)$/m.exec(recipe)?.[1]
  const release = /^PKG_RELEASE:=([0-9]+)$/m.exec(recipe)?.[1]
  if (!version || !release) throw new Error('Invalid generated package version')
  const apkName = `luci-app-cpe-status-${version}-r${release}.apk`
  const artifactName = apkFilename(version, Number(release), architecture)
  const sourceName = `source-${version}-r${release}-${Date.now()}`
  // A fresh staging directory prevents obsolete hashed JS chunks from previous
  // builds being copied into the APK by scp's additive directory upload.
  await ssh(`set -eu\nmkdir "$HOME/${root}/${sourceName}"\ntest -f "$HOME/${root}/sdk/rules.mk"\n`)
  await run('scp', [...sshOptions, '-r', 'build/openwrt-status-package/.', `${host}:${root}/${sourceName}/`])
  const job = `#!/bin/sh
set -eu
cd "$HOME/${root}"
lock="$PWD/build.lock"
mkdir "$lock" || { echo 'An SDK build already owns build.lock'; exit 1; }
trap 'rmdir "$lock"' EXIT
sdk="$PWD/sdk"
download_cache="$HOME/cpe-status-build/immortalwrt-25.12.2/sdk/dl"
cd "$sdk"
./scripts/feeds update base packages luci
./scripts/feeds install -p luci luci-base
./scripts/feeds install -p packages sms-tool
mkdir -p package/luci-app-cpe-status
rsync -a --delete ../${sourceName}/ package/luci-app-cpe-status/
touch .config
sed -i '/^CONFIG_ALL=/d; /^CONFIG_ALL_KMODS=/d; /^CONFIG_ALL_NONSHARED=/d; /^CONFIG_PACKAGE_luci-app-cpe-status=/d' .config
printf '\n# CONFIG_ALL is not set\n# CONFIG_ALL_KMODS is not set\n# CONFIG_ALL_NONSHARED is not set\nCONFIG_PACKAGE_luci-app-cpe-status=m\n' >> .config
make defconfig </dev/null
make package/luci-app-cpe-status/clean V=s </dev/null
make package/luci-app-cpe-status/compile -j2 V=s DL_DIR="$download_cache" </dev/null
cd ..
mkdir -p artifacts
find sdk/bin -type f -name '${apkName}' -exec cp -p -t artifacts/ {} +
test -f artifacts/${apkName}
cp -p artifacts/${apkName} artifacts/${artifactName}
sha256sum artifacts/${artifactName} > artifacts/SHA256SUMS
cp sdk/.config artifacts/sdk.config
cp sdk/feeds.conf.default artifacts/feeds.conf.default
sdk/staging_dir/host/bin/apk --allow-untrusted verify artifacts/${artifactName}
sdk/staging_dir/host/bin/apk adbdump artifacts/${artifactName} > artifacts/package-metadata.yaml
grep -q '^  arch: ${architecture}$' artifacts/package-metadata.yaml
printf '\nBUILD_SUCCESS\n'
`
  // Quoted heredoc preserves the Make/shell variables in the generated job.
  await ssh(`set -eu\ncd "$HOME/${root}"\ncat > package-job.sh <<'CPE_PACKAGE_JOB_EOF'\n${job}\nCPE_PACKAGE_JOB_EOF\nnohup sh package-job.sh > package.log 2>&1 < /dev/null &\necho "build_pid=$!"\n`)
  await mkdir(destination, { recursive: true })
  await writeFile(`${destination}/package-job.sh`, job)
} else if (action === 'status') {
  await ssh(`cd "$HOME/${root}"\ntest ! -f package.log || tail -c 12000 package.log | tr '\\r' '\\n' | tail -n 25\n`)
} else if (action === 'fetch') {
  await ssh(`set -eu\ncd "$HOME/${root}"\ngrep -q BUILD_SUCCESS package.log\n`)
  await mkdir(destination, { recursive: true })
  await run('scp', [...sshOptions, `${host}:${root}/artifacts/SHA256SUMS`, destination])
  const sums = await readFile(`${destination}/SHA256SUMS`, 'utf8')
  const files = sums.trim().split('\n').map(line => {
    const entry = /^([a-f0-9]{64})  artifacts\/(luci-app-cpe-status-[\d.]+-r\d+-(?:aarch64_cortex-a53|x86_64)\.apk)$/.exec(line)
    if (!entry || !entry[2].endsWith(`-${architecture}.apk`)) throw new Error('Unexpected SDK checksum manifest entry')
    return { hash: entry[1], name: entry[2] }
  })
  for (const file of files) await run('scp', [...sshOptions, `${host}:${root}/artifacts/${file.name}`, destination])
  for (const file of ['package-metadata.yaml', 'sdk.config', 'feeds.conf.default']) await run('scp', [...sshOptions, `${host}:${root}/artifacts/${file}`, destination])
  await run('scp', [...sshOptions, `${host}:${root}/package.log`, destination])
  const verified: string[] = []
  for (const file of files) {
    const checksum = createHash('sha256').update(await readFile(`${destination}/${file.name}`)).digest('hex')
    if (checksum !== file.hash) throw new Error('Downloaded APK checksum mismatch: ' + file.name)
    verified.push(`${checksum}  ${file.name}`)
  }
  if (!verified.length) throw new Error('SDK returned no APK files')
  await writeFile(`${destination}/SHA256SUMS`, verified.join('\n') + '\n')
  console.log('SDK build artifacts: ' + destination)
} else throw new Error('Usage: package-status-sdk.ts start|status|fetch [aarch64_cortex-a53|x86_64]')
