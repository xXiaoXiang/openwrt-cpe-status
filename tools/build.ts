import { mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { resolve as resolvePath, dirname } from 'node:path'
import { rm500q } from '../adapters/quectel-rm500q-gl-r11.ts'
import { validateAdapter } from '../backend/engine.ts'
import { providerAssets } from '../frontend/provider-assets.ts'
import { generatePackage } from '../openwrt/package.ts'
import { generateLightweightPackage } from '../openwrt/lightweight-package.ts'
import { guide } from '../docs/guide.ts'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const esbuild = await import(pathToFileURL(viteRequire.resolve('esbuild')).href) as { build(options: Record<string, unknown>): Promise<unknown> }
await mkdir('build/adapters', { recursive: true })
validateAdapter(rm500q)
await writeFile('build/adapters/quectel-rm500q-gl-r11.json', JSON.stringify(rm500q, null, 2))
await mkdir('frontend/public/provider', { recursive: true })
for (const [name, contents] of Object.entries(providerAssets)) await writeFile(`frontend/public/provider/${name}`, contents)
await writeFile('DEV.md', guide)
for (const [entry, outfile] of [['backend/main.ts', 'build/daemon.mjs'], ['openwrt/rpc-bridge.ts', 'build/rpc-bridge.mjs']]) await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', sourcemap: true })
await new Promise<void>((resolve, reject) => {
  const command = spawn(process.execPath, [resolvePath(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'frontend/vite.config.ts'], { stdio: 'inherit', windowsHide: true })
  command.on('error', reject)
  command.on('exit', code => code === 0 ? resolve() : reject(new Error(`Vite exit ${code}`)))
})
// Fixed generated path inside this project only; remove obsolete generated views.
const packageRoot = resolvePath('build/openwrt-package')
if (dirname(packageRoot) !== resolvePath('build')) throw new Error('Generated package path escaped the project build directory')
await rm(packageRoot, { recursive: true, force: true })
await generatePackage('build/openwrt-package')
const lightweightRoot = resolvePath('build/openwrt-status-package')
if (dirname(lightweightRoot) !== resolvePath('build')) throw new Error('Generated package path escaped the build directory')
await rm(lightweightRoot, { recursive: true, force: true })
await generateLightweightPackage('build/openwrt-status-package')
console.log('Built daemon, adapter JSON, frontend and OpenWrt package sources.')
