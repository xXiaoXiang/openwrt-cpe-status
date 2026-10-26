import { mkdir, writeFile } from 'node:fs/promises'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'

// Maintainer tool: explicitly regenerate the bundled default after changing
// the TypeScript reference adapter. Normal builds copy editable .conf files.
await mkdir('modem.d', { recursive: true })
await writeFile('modem.d/2c7c0800.conf', JSON.stringify(rm500qProfile, null, 2) + '\n')
console.log('Generated modem.d/2c7c0800.conf')
