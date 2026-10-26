import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { cellScanAt, cellScanReader } from '../openwrt/cell-scan.ts'
import { modemControl, modemControlResult } from '../openwrt/modem-control.ts'
import { parseCellScan } from '../shared/cell-scan.ts'

// Explicitly invoked manual scan, not part of the build/test suite. Uses the
// production AT lock and fixed QSCAN command; never changes RF/RAT/cell locks.
const root = '/tmp/cpe-scan-live-' + process.pid
const script = [
  'set -eu', 'umask 077', `mkdir ${root}`,
  ...Object.entries({ control: modemControl, result: modemControlResult, 'scan-at': cellScanAt, scan: cellScanReader }).flatMap(([file, content], i) => [`cat >${root}/${file} <<'CPE_SCAN_${i}'`, content, `CPE_SCAN_${i}`, `chmod 700 ${root}/${file}`]),
  `export CPE_STATUS_CONTROL_SCRIPT=${root}/control CPE_STATUS_SCAN_AT_SCRIPT=${root}/scan-at`,
  `${root}/control scan >${root}/start.json`,
  `ucode -e 'import {readfile} from "fs"; let r=json(readfile("${root}/start.json")); if(r.status!="pending") die(sprintf("%J",r));'`,
  `i=0; while test "$i" -lt 115; do ${root}/scan >${root}/result.json; state=$(ucode -e 'import {readfile} from "fs"; print(json(readfile("${root}/result.json")).scanning?"running":"done");'); if test "$state" = done; then break; fi; sleep 2; i=$((i+1)); done`,
  `cat ${root}/result.json`,
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() })
child.stderr.on('data', part => { stderr += part.toString() })
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/scan-live.json', stdout)
await writeFile('build/router-audit/scan-live-errors.txt', stderr)
assert.equal(code, 0, stderr + stdout.slice(-1000))
const result = JSON.parse(stdout)
assert.equal(result.status, 'ok', result.message)
assert.equal(result.scanning, false)
const cells = parseCellScan(result.data.raw)
console.log(JSON.stringify({ root, status: result.status, cells: cells.cells.length, technologies: [...new Set(cells.cells.map(cell => cell.tech))], rawInPrivateAuditDirectory: true }))
