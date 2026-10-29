import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile,writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { joinSmsSegments, type ArchivedSms } from '../shared/sms-history.ts'

// Read installed state and request the storage check. Never mark actual SMS as
// read or submit cleanup: the user tests real deletion themselves.
const script=String.raw`set -eu
ucode -c -o /dev/null /usr/libexec/cpe-status/messaging
for n in 1 2 3 4 5; do
  /usr/libexec/cpe-status/messaging storage-check >/tmp/cpe-status/installed-sms-check.json
  grep -q '"status": "ok"' /tmp/cpe-status/installed-sms-check.json && break
  sleep 1
done
ucode -e '
import {readfile} from "fs";
let config=json(readfile("/etc/cpe-status/config.json")),path=config.smsStorage+"/cpe-sms-history.json";
let archive=json(readfile(path)),backup=json(readfile(replace(path,".json",".pre-v2.json")));
print(sprintf("%J\n",{check:json(readfile("/tmp/cpe-status/installed-sms-check.json")),archive,backup_count:length(backup.records),view:readfile("/www/luci-static/resources/view/modem/cpe-status.js")}));'
`
const output=execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',process.env.CPE_ROUTER||'root@192.168.6.248','sh -s'],{input:script,encoding:'utf8',timeout:30000,windowsHide:true})
const result=JSON.parse(output) as {check:{status:string;data:{records:number;unread:number}};archive:{version:number;records:ArchivedSms[]};backup_count:number;view:string}
assert.equal(result.check.status,'ok')
assert.equal(result.archive.version,2)
assert.equal(createHash('sha256').update(result.view).digest('hex'),createHash('sha256').update(await readFile('build/openwrt-status-package/files/www/luci-static/resources/view/modem/cpe-status.js')).digest('hex'))
const summary={version:'1.3.0-r2',originalArchiveRecords:result.backup_count,archivedSegments:result.archive.records.length,displayedMessages:joinSmsSegments(result.archive.records).length,unreadMessages:joinSmsSegments(result.archive.records).filter(row=>row.status==='received').length,originalArchiveBackedUp:true,installedLuciViewMatchesBuild:true,realSmsDeletionTested:false}
await writeFile('build/sms-check/installed-audit.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary))
