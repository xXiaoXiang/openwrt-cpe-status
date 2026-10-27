import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { packageManifest, typescriptConfig } from '../project.ts'
import { guide } from '../docs/guide.ts'
import { licenseText } from '../docs/license.ts'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
await mkdir('frontend', { recursive: true })
await writeFile('package.json', JSON.stringify(packageManifest, null, 2) + '\n')
await writeFile('tsconfig.json', JSON.stringify(typescriptConfig, null, 2) + '\n')
await writeFile('frontend/index.html', '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Modem 状态监测</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n')
await writeFile('DEV.md', guide)
await writeFile('LICENSE', licenseText)
console.log('Generated package.json, tsconfig.json, frontend/index.html and DEV.md. Next: npm install; npm run check; npm test; npm run build')
