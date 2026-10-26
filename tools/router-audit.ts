import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const script = `
run() {
  "$@" &
  task=$!
  ( sleep 8; kill "$task" 2>/dev/null; sleep 1; kill -9 "$task" 2>/dev/null ) &
  guard=$!
  wait "$task"
  result=$?
  kill "$guard" 2>/dev/null
  wait "$guard" 2>/dev/null
  echo "exit=$result"
}
echo '>>> ttyUSB2 AT'
run sms_tool -d /dev/ttyUSB2 at 'AT'
echo '>>> ttyUSB3 AT'
run sms_tool -d /dev/ttyUSB3 at 'AT'
for cmd in 'AT+CGMM' 'AT+CGMR' 'AT+CFUN?' 'AT+CPIN?' 'AT+CSQ' 'AT+COPS?' 'AT+CEREG?' 'AT+C5GREG?' 'AT+QENG="servingcell"' 'AT+QENG="neighbourcell"' 'AT+QCAINFO' 'AT+QTEMP' 'AT+QSPN' 'AT+QNWINFO'; do
  printf '\\n>>> %s\\n' "$cmd"
  run sms_tool -d /dev/ttyUSB2 at "$cmd"
done
echo '>>> 3ginfo JSON'
run /usr/share/3ginfo-lite/3ginfo.sh json
echo '>>> netifd'
ubus call network.interface.wwan status
echo '>>> utilities'
ls -l /usr/bin/sms_tool
command -v ucode
command -v flock
command -v node
echo '>>> done'
`
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script.replace(/\r/g, '') + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', chunk => { stdout += chunk.toString() })
child.stderr.on('data', chunk => { stderr += chunk.toString() })
const timer = setTimeout(() => child.kill(), 180_000)
await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()) })
clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/raw.txt', stdout)
await writeFile('build/router-audit/stderr.txt', stderr)
// Keep SIM identifiers and PDP addressing out of the interactive transcript.
console.log(stdout.split('>>> 3ginfo JSON')[0])
console.log(stderr)
console.log('Full private capture: build/router-audit/raw.txt')
