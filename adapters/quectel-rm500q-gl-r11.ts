import { cacheSeconds } from '../shared/cache-policy.ts'
import type { CommandDefinition, FieldRule, ModemAdapter, ReplyRule } from '../shared/adapter.ts'

const reference = 'Quectel RG50xQ&RM5xxQ Series AT Commands Manual V1.2 (2021-08-09)'
const field = (index: number, type: FieldRule['type'] = 'string', extra: Partial<FieldRule> = {}): FieldRule => ({ index, type, ...extra })
const measurement = (index: number, extra: Partial<FieldRule> = {}) => field(index, 'number', { optional: true, unknown: ['-', '-32768', '65535'], ...extra })
const rule = (regex: string, fields: ReplyRule['fields'], constants?: ReplyRule['constants'], format: ReplyRule['format'] = 'csv'): ReplyRule => ({ regex, fields, constants, format })
const query = (command: string, ttlMs: number, rules: ReplyRule[], extra: Partial<CommandDefinition> = {}): CommandDefinition => ({ command, kind: 'read', ttlMs: (/^AT\+(CGMI|CGMM|CGMR|CGSN|CFUN\?|QCCID|CIMI|CNUM|CSCA\?)/.test(command) || /^AT\+QNWPREFCFG="(roam_pref|mode_pref|lte_band|nsa_nr5g_band|nr5g_band|ue_capability_band)"$/.test(command) || command.startsWith('AT+QNWLOCK=')) ? cacheSeconds.sim * 1000 : command.startsWith('AT+QENG=') || command === 'AT+QCAINFO' ? cacheSeconds.cells * 1000 : ttlMs >= 30_000 ? 4000 : 2000, staleMs: 172_800_000, timeoutMs: 5000, rules, reference, ...extra })
const write = (command: string, parameters: Record<string, string>, invalidates: string[], extra: Partial<CommandDefinition> = {}): CommandDefinition => ({ command, kind: 'write', ttlMs: 0, timeoutMs: 60_000, rules: [], allowEmpty: true, parameters, invalidates, reference, ...extra })
const lteBandwidth = { '0': 1.4, '1': 3, '2': 5, '3': 10, '4': 15, '5': 20 }
const nrBandwidth = { '0': 5, '1': 10, '2': 15, '3': 20, '4': 25, '5': 30, '6': 40, '7': 50, '8': 60, '9': 70, '10': 80, '11': 90, '12': 100, '13': 200, '14': 400 }
// SA and NSA use the same enum, not LTE resource blocks or literal MHz.
// An unavailable width must not discard the other serving-cell measurements.
const nrWidth = (index: number) => ({
  bandwidth_mhz: field(index, 'string', { map: nrBandwidth, optional: true, unknown: ['-', '-32768', '65535', '255'] }),
  bandwidth_code: measurement(index, { unknown: ['-', '-32768', '65535', '255'] }),
})
const lteFields = (start: number) => ({
  mcc: field(start), mnc: field(start + 1), cell_id: field(start + 2, 'hex'), pci: field(start + 3, 'number', { min: 0, max: 503 }),
  arfcn: field(start + 4, 'number'), band_number: field(start + 5, 'number'),
  bandwidth_mhz: field(start + 7, 'string', { map: lteBandwidth }), tac: field(start + 8, 'hex'),
  rsrp: measurement(start + 9), rsrq: measurement(start + 10), rssi: measurement(start + 11),
  sinr: measurement(start + 12, { scale: 2, offset: -20 }),
})
const networkInvalidates = ['registration', 'registration5g', 'operator', 'serving', 'neighbors', 'signal', 'qos', 'radio', 'attach', 'contextsActive']

export const rm500q: ModemAdapter = {
  schemaVersion: 1,
  id: 'quectel-rm500q-gl-r11', manufacturer: 'Quectel', modelPattern: '^RM500Q-GL$', firmwareBaseline: 'RM500QGL…R11… (configuration baseline; hardware validation pending)',
  transport: { baudRate: 115200, preferredUsbInterface: 'USB AT interface; often ttyUSB2, never assume the enumeration index', note: 'Do not open DIAG/NMEA/QMI/MBIM/PPP ports. Pick one dedicated AT interface and avoid sharing with ModemManager/comgt.' },
  documents: [{ title: reference, url: 'https://www.quectel.com/content/uploads/2024/02/Quectel_RG50xQRM5xxQ_Series_AT_Commands_Manual_V1.2.pdf', scope: 'Official public PDF; includes RM500Q series, QENG §5.20, QNWPREFCFG §5.25, SMS §8. Not an R11-specific conformance certificate.' }],
  commands: {
    manufacturer: query('AT+CGMI', 300_000, [rule('^(Quectel.*)$', { manufacturer: field(0) }, undefined, 'captures')]),
    model: query('AT+CGMM', 300_000, [rule('^(RM[0-9A-Za-z-]+)$', { model: field(0) }, undefined, 'captures')]),
    revision: query('AT+CGMR', 300_000, [rule('^((?:RM500QGL|Revision:).*)$', { revision: field(0) }, undefined, 'captures')]),
    imei: query('AT+CGSN', 300_000, [rule('^(\\d{15})$', { imei: field(0) }, undefined, 'captures')]),
    radio: query('AT+CFUN?', 10_000, [rule('^\\+CFUN:\\s*(.*)$', { functionality: field(0, 'number', { min: 0, max: 7 }) })]),
    airplaneSet: write('AT+CFUN={functionality}', { functionality: '1|4' }, networkInvalidates),
    simPin: query('AT+CPIN?', 30_000, [rule('^\\+CPIN:\\s*(.*)$', { pin_required: field(0) })]),
    iccid: query('AT+QCCID', 30_000, [rule('^\\+QCCID:\\s*(\\d{18,22})[fF]?$', { iccid: field(0) }, undefined, 'captures')]),
    imsi: query('AT+CIMI', 30_000, [rule('^(\\d{14,16})$', { imsi: field(0) }, undefined, 'captures')]),
    phone: query('AT+CNUM', 30_000, [rule('^\\+CNUM:\\s*(.*)$', { number: field(1) })], { optional: true, allowEmpty: true }),
    smsCenter: query('AT+CSCA?', 30_000, [rule('^\\+CSCA:\\s*(.*)$', { sms_center: field(0) })]),
    registration: query('AT+CEREG?', 10_000, [rule('^\\+CEREG:\\s*(.*)$', { reporting: field(0, 'number'), status: field(1, 'number'), tac: field(2, 'hex', { optional: true }), cell_id: field(3, 'hex', { optional: true }), act: field(4, 'number', { optional: true }) })]),
    registration5g: query('AT+C5GREG?', 10_000, [rule('^\\+C5GREG:\\s*(.*)$', { reporting: field(0, 'number'), status: field(1, 'number'), tac: field(2, 'hex', { optional: true }), cell_id: field(3, 'hex', { optional: true }), act: field(4, 'number', { optional: true }) })], { optional: true }),
    operator: query('AT+COPS?', 10_000, [rule('^\\+COPS:\\s*(.*)$', { mode: field(0, 'number'), format: field(1, 'number', { optional: true }), operator: field(2, 'string', { optional: true }), act: field(3, 'number', { optional: true }) })]),
    roamingPreference: query('AT+QNWPREFCFG="roam_pref"', 30_000, [rule('^\\+QNWPREFCFG:\\s*("roam_pref",.*)$', { roam_pref: field(1, 'string', { map: { '1': 1, '3': 3, '255': 255 } }) })]),
    roamingSet: write('AT+QNWPREFCFG="roam_pref",{preference}', { preference: '1|255' }, ['roamingPreference'], { timeoutMs: 5000, note: '1=home only (off), 255=any network (on). Changes registration preference immediately and persists; confirm by querying roam_pref.' }),
    provider: query('AT+QSPN', 30_000, [rule('^\\+QSPN:\\s*(.*)$', { provider_name: field(0), plmn: field(4, 'string', { optional: true }) })], { optional: true }),
    operatorScan: query('AT+COPS=?', 300_000, [rule('^\\+COPS:\\s*(.*)$', { operators_raw: field(0) }, undefined, 'captures')], { timeoutMs: 180_000, allowEmpty: true }),
    operatorAuto: write('AT+COPS=0', {}, networkInvalidates, { timeoutMs: 180_000 }),
    operatorManual: write('AT+COPS=1,2,"{plmn}"', { plmn: '\\d{5,6}' }, networkInvalidates, { timeoutMs: 180_000 }),
    signal: query('AT+CSQ', 10_000, [rule('^\\+CSQ:\\s*(.*)$', { rssi_code: field(0, 'number'), ber: field(1, 'number') })]),
    serving: query('AT+QENG="servingcell"', 30_000, [
      rule('^\\+QENG:\\s*("servingcell","(?:SEARCH|LIMSRV|NOCONN|CONNECT)","LTE",.*)$', { ...lteFields(4), state: field(1) }, { tech: 'lte', is_serving: true }),
      rule('^\\+QENG:\\s*("LTE",.*)$', lteFields(2), { tech: 'lte', is_serving: true }),
      rule('^\\+QENG:\\s*("NR5G-NSA",.*)$', {
        mcc: field(1), mnc: field(2), pci: measurement(3, { min: 0, max: 1007 }), rsrp: measurement(4), sinr: measurement(5), rsrq: measurement(6),
        arfcn: measurement(7), band_number: measurement(8), ...nrWidth(9), scs: measurement(10),
      }, { tech: 'nr', is_serving: true, is_secondary: true }),
      rule('^\\+QENG:\\s*("servingcell","(?:SEARCH|LIMSRV|NOCONN|CONNECT)","NR5G-SA",.*)$', {
        state: field(1), mcc: field(4), mnc: field(5), cell_id: field(6, 'hex'), pci: field(7, 'number'), tac: field(8, 'hex'), arfcn: field(9, 'number'),
        band_number: field(10, 'number'), ...nrWidth(11), rsrp: measurement(12), rsrq: measurement(13), sinr: measurement(14), scs: measurement(15),
      }, { tech: 'nr', is_serving: true }),
      rule('^\\+QENG:\\s*("servingcell","(?:SEARCH|LIMSRV|NOCONN|CONNECT)")$', { state: field(1) }),
    ], { reference: `${reference} §5.20 pp.103–108`, example: '+QENG: "servingcell","NOCONN"\r\n+QENG: "LTE","FDD",460,01,5F1EA15,12,1650,3,5,5,DE10,-99,-12,-67,11,9,230,-\r\n+QENG: "NR5G-NSA",460,01,747,-71,13,-11,627264,78,12,1\r\nOK\r\n', note: 'LTE SINR = raw * 2 - 20 dB. NR SINR is dB. NR bandwidth is an enum, only valid in RRC CONNECT. Zero/invalid NR rows do not prove NSA.' }),
    neighbors: query('AT+QENG="neighbourcell"', 30_000, [rule('^\\+QENG:\\s*("neighbourcell (?:intra|inter)","LTE",.*)$', { arfcn: measurement(2), pci: measurement(3), rsrq: measurement(4), rsrp: measurement(5), rssi: measurement(6), sinr: measurement(7, { scale: 2, offset: -20 }) }, { tech: 'lte', is_serving: false })], { allowEmpty: true, optional: true }),
    carriers: query('AT+QCAINFO', 30_000, [
      rule('^\\+QCAINFO:\\s*("(?:PCC|SCC)",\\d+,\\d+,"LTE BAND \\d+",.*)$', {
        carrier_role: field(0), arfcn: measurement(1), bandwidth_mhz: field(2, 'string', { map: { '6': 1.4, '15': 3, '25': 5, '50': 10, '75': 15, '100': 20 } }),
        band_number: field(3, 'number', { pattern: 'BAND ([0-9]+)$' }), band_label: field(3), pci: measurement(5), rsrp: measurement(6), rsrq: measurement(7), rssi: measurement(8), rssnr: measurement(9),
      }, { tech: 'lte' }),
      // R13 hardware: "SCC",632352,7,"NR5G BAND 78",41.
      // NR has PCI at index 4, no LTE state field, and uses bandwidth enums.
      rule('^\\+QCAINFO:\\s*("(?:PCC|SCC)",\\d+,\\d+,"NR5G BAND \\d+",\\d+)$', {
        carrier_role: field(0), arfcn: measurement(1), ...nrWidth(2), band_number: field(3, 'number', { pattern: 'BAND ([0-9]+)$' }), band_label: field(3), pci: measurement(4),
      }, { tech: 'nr' }),
    ], { optional: true, allowEmpty: true, note: 'LTE width uses resource blocks; R13 NR width uses the QENG NR enum. LTE field 9 is RSSNR in dB, not the QENG SINR enum. NR QCAINFO only supplements a matching valid QENG cell.' }),
    attach: query('AT+CGATT?', 10_000, [rule('^\\+CGATT:\\s*(.*)$', { attached: field(0, 'boolean') })]),
    contexts: query('AT+CGDCONT?', 10_000, [rule('^\\+CGDCONT:\\s*(.*)$', { cid: field(0, 'number'), protocol: field(1), apn: field(2), address: field(3, 'string', { optional: true }) })], { allowEmpty: true }),
    contextsActive: query('AT+CGACT?', 10_000, [rule('^\\+CGACT:\\s*(.*)$', { cid: field(0, 'number'), active: field(1, 'boolean') })], { allowEmpty: true }),
    apnSet: write('AT+CGDCONT={cid},"{protocol}","{apn}"', { cid: '[1-9]|1[0-6]', protocol: 'IP|IPV6|IPV4V6', apn: '[A-Za-z0-9._-]{0,100}' }, ['contexts', 'contextsActive']),
    mode: query('AT+QNWPREFCFG="mode_pref"', 30_000, [rule('^\\+QNWPREFCFG:\\s*("mode_pref",.*)$', { mode: field(1) })]),
    modeSet: write('AT+QNWPREFCFG="mode_pref",{mode}', { mode: 'AUTO|LTE|NR5G|LTE:NR5G|WCDMA|WCDMA:LTE' }, ['mode', ...networkInvalidates]),
    lteCellLock: query('AT+QNWLOCK="common/4g"', 30_000, [rule('^\\+QNWLOCK:\\s*"common/4g",(.*)$', { lock: field(0) }, undefined, 'captures')]),
    nrCellLock: query('AT+QNWLOCK="common/5g"', 30_000, [rule('^\\+QNWLOCK:\\s*"common/5g",(.*)$', { lock: field(0) }, undefined, 'captures')]),
    lteCellLockSet: write('AT+QNWLOCK="common/4g",1,{arfcn},{pci}', { arfcn: '[0-9]{1,6}', pci: '[0-9]{1,3}' }, ['lteCellLock', ...networkInvalidates]),
    nrCellLockSet: write('AT+QNWLOCK="common/5g",{pci},{arfcn},{scs},{band}', { pci: '[1-9][0-9]{0,3}', arfcn: '[1-9][0-9]{0,6}', scs: '15|30', band: '[1-9][0-9]{0,2}' }, ['nrCellLock', ...networkInvalidates], { reference: 'Quectel forum 12731 technical-support manual screenshots; RM500Q R13 QNWLOCK=? confirms pci,freq,scs,band; SCS in kHz. NSA is not blocked in UI; confirm actual QNWLOCK readback.' }),
    lteCellUnlock: write('AT+QNWLOCK="common/4g",0', {}, ['lteCellLock', ...networkInvalidates]),
    nrCellUnlock: write('AT+QNWLOCK="common/5g",0', {}, ['nrCellLock', ...networkInvalidates]),
    lteBands: query('AT+QNWPREFCFG="lte_band"', 30_000, [rule('^\\+QNWPREFCFG:\\s*("lte_band",.*)$', { bands: field(1) })]),
    nsaBands: query('AT+QNWPREFCFG="nsa_nr5g_band"', 30_000, [rule('^\\+QNWPREFCFG:\\s*("nsa_nr5g_band",.*)$', { bands: field(1) })]),
    nrBands: query('AT+QNWPREFCFG="nr5g_band"', 30_000, [rule('^\\+QNWPREFCFG:\\s*("nr5g_band",.*)$', { bands: field(1) })]),
    bandCapabilities: query('AT+QNWPREFCFG="ue_capability_band"', 300_000, [rule('^\\+QNWPREFCFG:\\s*("(?:gw_band|lte_band|nsa_nr5g_band|nr5g_band)",.*)$', { rat: field(0), bands: field(1) })]),
    bandSet: write('AT+QNWPREFCFG="{rat}",{bands}', { rat: 'lte_band|nsa_nr5g_band|nr5g_band', bands: '[1-9][0-9]{0,2}(?::[1-9][0-9]{0,2}){0,63}' }, ['lteBands', 'nsaBands', 'nrBands', ...networkInvalidates], { note: 'Unlock by restoring the saved pre-lock band set, not by writing undocumented 0/AUTO. NSA and SA have independent masks.' }),
    clock: query('AT+CCLK?', 30_000, [rule('^\\+CCLK:\\s*(.*)$', { time_string: field(0) })]),
    temperature: query('AT+QTEMP', 30_000, [rule('^\\+QTEMP:\\s*(.*)$', { sensor: field(0), temperature: field(1, 'number') })], { optional: true }),
    qos: query('AT+CGEQOSRDP', 30_000, [rule('^\\+CGEQOSRDP:\\s*(.*)$', { cid: field(0, 'number'), qci: field(1, 'number'), dl_gbr: measurement(2), ul_gbr: measurement(3), dl_mbr: measurement(4), ul_mbr: measurement(5), dl_ambr: measurement(6), ul_ambr: measurement(7) })], { optional: true, requiresValidation: true, reference: '3GPP TS 27.007; not listed in the downloaded Quectel V1.2 manual. Disabled until device support is confirmed.' }),
    smsPduMode: write('AT+CMGF=0', {}, []),
    smsList: query('AT+CMGL=4', 10_000, [rule('^\\+CMGL:\\s*(.*)$', { index: field(0, 'number'), storage_status: field(1, 'number') })], { allowEmpty: true, timeoutMs: 15_000, note: 'PDU body on the following line is decoded by the shared SMS codec; only read on explicit SMS page demand.' }),
    smsDelete: write('AT+CMGD={index}', { index: '[1-9][0-9]{0,4}' }, ['smsList']),
    smsSend: write('AT+CMGS={length}', { length: '[1-9][0-9]{0,2}' }, ['smsList'], { timeoutMs: 120_000, note: 'Await > prompt, send validated TPDU plus Ctrl-Z, require +CMGS and final OK. Never retry automatically.' }),
  },
}
