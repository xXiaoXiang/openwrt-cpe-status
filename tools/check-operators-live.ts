import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { operatorAt } from '../openwrt/operators.ts'

// Read-only validation of the long AT transport on the real configured port.
// No scan, registration, data restart, RF or network configuration writes.
const remote = String.raw`set -eu
umask 077
task=/tmp/cpe-operator-transport-check
mkdir -p "$task"
cat > "$task/at.gcom" <<'CPE_OPERATOR_SCRIPT'
` + operatorAt + String.raw`CPE_OPERATOR_SCRIPT
port=$(ucode -e 'import {readfile} from "fs"; let cfg=json(readfile("/etc/cpe-status.json")); if(!match(cfg.device,/^\/dev\/tty(USB|ACM)[0-9]+$/)) exit(1); print(cfg.device);')
mkdir /tmp/cpe-status/lock || { echo 'Modem is busy'; exit 1; }
echo $$ >/tmp/cpe-status/lock/pid
trap 'rm -f /tmp/cpe-status/lock/pid; rmdir /tmp/cpe-status/lock' EXIT
export CPE_OPERATOR_COMMAND='AT+COPS?'
gcom -d "$port" -s "$task/at.gcom" & child=$!
(sleep 15; kill "$child" 2>/dev/null) >/dev/null 2>&1 & guard=$!
wait "$child"; result=$?
kill "$guard" 2>/dev/null || true
wait "$guard" 2>/dev/null || true
exit "$result"
`
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(remote)
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() }); child.stderr.on('data', part => { stderr += part.toString() })
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/operator-transport.txt', stdout + stderr)
assert.equal(code, 0, stdout + stderr)
assert.match(stdout, /\+COPS:/); assert.match(stdout, /\bOK\b/)
console.log(JSON.stringify({ readOnly: true, transport: 'gcom-env-command', output: stdout.trim() }))
