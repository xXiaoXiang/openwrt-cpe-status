import { profileFingerprint } from './profile-fixture.ts'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import { statusRuntime } from '../openwrt/status-collector.ts'
import { parseReply, renderCommand } from '../backend/parser.ts'
import { r13Snapshot, r13NsaCells } from '../tests/fixtures/rm500q-r13.ts'
import type { CommandDefinition } from '../shared/adapter.ts'

const root = `/tmp/cpe-profile-audit-${process.pid}`
const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
const target = process.env.CPE_ROUTER || 'root@192.168.6.248'
const cases: [string, string][] = []
for (const [key, group] of Object.entries(rm500qProfile.groups)) for (const name of group.names) cases.push([name, key === 'cells' ? r13NsaCells : r13Snapshot.raw[key] ?? ''])
cases.push(['lteCellLock', '+QNWLOCK: "common/4g",2,1400,366,3349,323'], ['lteCellLock', '+QNWLOCK: "common/4g",0'], ['nrCellLock', '+QNWLOCK: "common/5g",570,726432,30,79'], ['nrCellLock', '+QNWLOCK: "common/5g",0'], ['bandCapabilities', '+QNWPREFCFG: "lte_band",1:3:7\n+QNWPREFCFG: "nr5g_band",78:79\n+QNWPREFCFG: "nsa_nr5g_band",78:79'], ['operatorScan', '+COPS: (1,"CUniq (3HK)","CUniq","45403",7),(2,"UNICOM, HK","UNICOM","45400",7),,(0-4),(0-2)\nOK'], ['cellScan', '+QSCAN: "NR5G",454,00,632352,41,-86,-10,33,1,31E7C20,452,273,78\nOK'])
const expected = cases.map(([name, raw]) => { try { return parseReply(rm500qProfile.commands[name], raw) } catch { return null } })
const alternate = structuredClone(rm500qProfile)
alternate.id = 'example-other-model'; alternate.modelPattern = '^Other-X$'
alternate.commands.model.command = 'AT+MODEL?'
alternate.commands.model.rules = [{ regex: '^MODEL=(.*)$', format: 'captures', fields: { model: { index: 0 } } }]
alternate.commands.temperature = { ...alternate.commands.temperature, command: 'AT+THERM?', rules: [{ regex: '^HEAT=(.*)$', format: 'csv', fields: { sensor: { index: 0 }, temperature: { index: 1, type: 'number', scale: 0.1 } } }] }
const program = statusRuntime + `
if (!profile) die(profileError);
let cases = ${JSON.stringify(cases)}, output = [];
for (let item in cases) { try { push(output, profileParse(item[0], item[1])); } catch(e) { push(output, null); } }
mkdir(directory,0700);
save(directory+'/bands.json',{device:port,value:123});
let oldKey=profileKey, oldContent=readfile(config.modemDirectory+'/2c7c0800.conf');
writefile(config.modemDirectory+'/2c7c0800.conf', ${JSON.stringify(JSON.stringify(alternate))});
if (!refreshProfile()) die(profileError);
let changed={command:profileCommand('temperature'),reading:profileParse('temperature','HEAT=chip,435'),model:profileRow('model','MODEL=Other-X').model,invalidated:readJSON(directory+'/bands.json')==null,keyChanged:oldKey!=profileKey};
let injection=false;try{profileCommand('lteBandsSet',{bands:'3;AT+CFUN=4'});}catch(e){injection=true;}
let invalid = json(oldContent); invalid.usbIds = ['ffffffff']; writefile(config.modemDirectory+'/2c7c0800.conf',sprintf('%J',invalid));
let unmatchedUsbRejected = !refreshProfile();
invalid = json(oldContent); invalid.groups.status.names = ['airplaneSet']; writefile(config.modemDirectory+'/2c7c0800.conf',sprintf('%J',invalid));
let writeGroupRejected = !refreshProfile();
writefile(config.modemDirectory+'/2c7c0800.conf',oldContent);
print(sprintf('%J\\n',{usbId,output,changed,injection,unmatchedUsbRejected,writeGroupRejected,originalKey:oldKey}));
`
await mkdir('build/profile-audit', { recursive: true })
await writeFile('build/profile-audit/check.uc', program)
const content = JSON.stringify(rm500qProfile)
const config = JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan', modemDirectory: root + '/modem.d' })
const script = `set -eu
umask 077
mkdir -p ${root}/modem.d ${root}/cache
cat >${root}/modem.d/2c7c0800.conf <<'CPE_PROFILE_JSON'
${content}
CPE_PROFILE_JSON
cat >${root}/config.json <<'CPE_PROFILE_CONFIG'
${config}
CPE_PROFILE_CONFIG
cat >${root}/check.uc <<'CPE_PROFILE_CHECK'
${program}
CPE_PROFILE_CHECK
export CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_CACHE=${root}/cache
ucode -c -o ${root}/check.bin ${root}/check.uc
ucode ${root}/check.uc
`
const output = execFileSync('ssh', [...options, target, 'sh -s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 60000 })
await writeFile('build/profile-audit/result.json', output)
const result = JSON.parse(output)
assert.equal(result.usbId, '2c7c0800')
assert.deepEqual(result.output, expected)
assert.deepEqual(result.changed, { command: 'AT+THERM?', reading: [{ sensor: 'chip', temperature: 43.5 }], model: 'Other-X', invalidated: true, keyChanged: true })
assert.equal(result.injection, true)
assert.equal(result.unmatchedUsbRejected, true)
assert.equal(result.writeGroupRejected, true)
assert.equal(result.originalKey, profileFingerprint(content + '\n'))
const operations = Object.entries(rm500qProfile.commands).filter(([, operation]) => operation.kind === 'read')
for (const [, definition] of operations) assert.ok(renderCommand(definition as CommandDefinition).startsWith('AT'))
console.log(JSON.stringify({ passed: cases.length, usbBinding: true, runtimeCommandsAndRules: true, alternateModel: true, profileEditInvalidatesCache: true, parameterInjectionRejected: true, unknownUsbRejected: true, writeInReadGroupRejected: true }))
