import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { cellScanAt } from '../openwrt/cell-scan.ts'

// Native comgt plus a PTY tests terminal handling without running QSCAN on the
// real modem. Keep the distro package and fixtures under the build workspace.
const script = String.raw`set -eu
mkdir -p "$HOME/cpe-status-build/scan-reader-check"
cd "$HOME/cpe-status-build/scan-reader-check"
if ! test -x extracted/usr/bin/comgt; then
  apt-get download comgt >&2
  dpkg-deb -x comgt_*.deb extracted
fi
cat >scan.gcom <<'CPE_SCAN_SCRIPT'
__SCAN__
CPE_SCAN_SCRIPT
python3 - <<'CPE_PTY_TEST'
import os, pty, subprocess, select, time, json
reports = []
for terminal, expected in [(b'OK', 0), (b'ERROR', 1), (b'+CME ERROR: 3', 1)]:
    master, slave = pty.openpty()
    started = time.monotonic()
    proc = subprocess.Popen(['./extracted/usr/bin/comgt', '-d', os.ttyname(slave), '-s', 'scan.gcom'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    data = b''
    try:
        while b'AT+QSCAN=3,1\r' not in data and time.monotonic() - started < 4:
            if select.select([master], [], [], 0.2)[0]: data += os.read(master, 4096)
        assert b'AT+QSCAN=3,1\r' in data, data
        os.write(master, b'\r\n+QSCAN: "LTE",454,00,1400,366,-95,-13\r\n\r\n  ' + terminal + b'\r\n')
        out, err = proc.communicate(timeout=3)
        elapsed = time.monotonic() - started
        assert proc.returncode == expected, (proc.returncode, out, err)
        assert elapsed < 3, elapsed
        reports.append({'terminal': terminal.decode(), 'seconds': round(elapsed, 3), 'exit': proc.returncode})
    finally:
        if proc.poll() is None: proc.kill(); proc.communicate()
        os.close(master); os.close(slave)
print(json.dumps(reports))
CPE_PTY_TEST
`.replace('__SCAN__', cellScanAt)
const child = spawn('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts','baron@baron-omen.bulan','sh -s'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] })
child.stdin.end(script)
let output = '', error = ''
child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { error += data })
const timeout = setTimeout(() => child.kill(), 60000)
const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timeout)
await mkdir('build/router-audit', { recursive: true }); await writeFile('build/router-audit/scan-reader-check.txt', output + '\n' + error)
if (code !== 0) throw new Error(error + output)
console.log(output.trim())
