import { rm500q } from './quectel-rm500q-gl-r11.ts'
import type { CommandDefinition, ReplyRule } from '../shared/adapter.ts'
import type { ModemProfile } from '../shared/modem-profile.ts'
import { cacheSeconds } from '../shared/cache-policy.ts'

const f = (index: number, type: 'number' | 'string' | 'hex' = 'string', extra = {}) => ({ index, type, ...extra })
const r = (regex: string, fields: ReplyRule['fields'], constants?: ReplyRule['constants']): ReplyRule => ({ regex, format: 'csv', fields, constants })
const query = (command: string, rules: ReplyRule[], extra = {}): CommandDefinition => ({ command, kind: 'read', ttlMs: 86400000, timeoutMs: 5000, rules, reference: 'Quectel RM5xxQ AT manual / 3GPP TS 27.007', ...extra })
const commands = structuredClone(rm500q.commands)
commands.modeSet.parameterValues = { mode: ['AUTO', 'LTE:NR5G', 'LTE', 'NR5G', 'WCDMA:LTE', 'WCDMA'] }
commands.roamingSet.parameterValues = { preference: ['1', '255'] }
commands.model.rules = [{ regex: '^(RM500Q-GL)$', format: 'captures', fields: { model: f(0) } }]
for (const rule of commands.carriers.rules) rule.fields.band_number = f(3, 'number', { pattern: 'BAND ([0-9]+)$' })
commands.bandCapabilities.rules = [r('^\\+QNWPREFCFG:\\s*("(lte_band|nr5g_band|nsa_nr5g_band)",.*)$', { rat: f(0, 'string', { map: { lte_band: 'lte', nr5g_band: 'sa', nsa_nr5g_band: 'nsa' } }), bands: f(1) })]
for (const [name, rat] of [['lteBands', 'lte'], ['nrBands', 'sa'], ['nsaBands', 'nsa']]) commands[name].rules[0].constants = { rat }
for (const [name, rat] of [['lteBandsSet','lte_band'],['nrBandsSet','nr5g_band'],['nsaBandsSet','nsa_nr5g_band']]) commands[name] = { ...structuredClone(commands.bandSet), command: `AT+QNWPREFCFG="${rat}",{bands}`, parameters: { bands: '[1-9][0-9]{0,2}(:[1-9][0-9]{0,2}){0,127}' } }
commands.lteCellLock.rules = [
  r('^\\+QNWLOCK:\\s*"common/4g",\\s*(0)\\s*$', { count: f(0, 'number') }),
  { ...r('^\\+QNWLOCK:\\s*"common/4g",\\s*(.*)$', { arfcn: f(0, 'number', { min: 0, max: 262143 }), pci: f(1, 'number', { min: 0, max: 503 }) }, { rat: 'lte' }), repeat: { start: 1, stride: 2, countIndex: 0, maximum: 10 } },
]
commands.nrCellLock.rules = [
  r('^\\+QNWLOCK:\\s*"common/5g",\\s*(0)(,0,0,0)?\\s*$', { count: f(0, 'number') }),
  { ...r('^\\+QNWLOCK:\\s*"common/5g",\\s*(.*)$', { pci: f(0, 'number', { min: 1, max: 1007 }), arfcn: f(1, 'number', { min: 1, max: 3279165 }), scs_khz: f(2, 'number', { map: { '15': 15, '30': 30, '60': 60, '120': 120, '240': 240 } }), band: f(3, 'number', { min: 1, max: 1024 }) }, { rat: 'nr' }), minimumFields: 4 },
]
commands.cellScan = query('AT+QSCAN=3,1', [r('^\\+QSCAN:\\s*(.*)$', { tech: f(0, 'string', { map: { LTE: 'lte', NR5G: 'nr' } }), mcc: f(1), mnc: f(2), arfcn: f(3, 'number'), pci: f(4, 'number'), rsrp: f(5, 'number', { optional: true, unknown: ['-'] }), rsrq: f(6, 'number', { optional: true, unknown: ['-'] }), scs: f(8, 'number', { optional: true, unknown: ['-'] }), band_number: f(12, 'number', { optional: true, unknown: ['-'] }) })], { timeoutMs: 185000, allowEmpty: true })
commands.operatorScan.rules = [{ ...r('^\\+COPS:\\s*(.*)$', { status: f(0, 'number'), long_name: f(1), short_name: f(2), plmn: f(3), technology: f(4, 'string', { optional: true, map: { '0':'GSM','2':'UMTS','7':'LTE','9':'NB-IoT','10':'LTE/5GC','11':'NR','12':'NR','13':'LTE/NR' } }) }), segments: '\\(([0-3],("[^"]*"|[^()"])+)\\)' }]
commands.operatorScan.allowEmpty = true
for (const [name, command] of [['simAdministrative','AT+CRSM=176,28589,0,0,4'],['simGroup','AT+CRSM=176,28478,0,0,1'],['simProvider','AT+CRSM=176,28486,0,0,17']]) commands[name] = query(command, [r('^\\+CRSM:\\s*144,\\s*0,\\s*"([0-9A-Fa-f]+)"$', { data: f(0) })], { optional: true, allowEmpty: true })
commands.imeiSet = { command: 'AT+EGMR=1,7,"{imei}"', kind: 'write', ttlMs: 0, timeoutMs: 5000, rules: [], allowEmpty: true, parameters: { imei: '[0-9]{15}' }, reference: 'Firmware-specific; only explicit user operation, never automatically executed.' }
// Use a common POSIX-compatible regex subset interpreted by both ucode and JS.
for (const command of Object.values(commands)) {
  for (const rule of command.rules) rule.regex = rule.regex.replaceAll('(?:', '(')
  for (const [name, pattern] of Object.entries(command.parameters ?? {})) command.parameters![name] = pattern.replaceAll('(?:', '(')
  command.output = command.rules.length ? command.rules.map((rule, index) => `规则${index + 1}: array<{${[...Object.entries(rule.constants ?? {}).map(([key,value]) => key + ':' + JSON.stringify(value)), ...Object.entries(rule.fields).map(([key,field]) => key + ':' + (field.map ? typeof Object.values(field.map)[0] : field.type === 'hex' ? 'number' : field.type ?? 'string') + (field.optional ? '|null' : ''))].join(',')}}>`).join('; ') : '写操作返回后仍需查询对应读取操作，比对实际状态；不单凭OK报告成功。'
}

export const rm500qProfile: ModemProfile = {
  ...structuredClone(rm500q), id: 'quectel-rm500q-gl', firmwareBaseline: 'R11 baseline; validated with RM500QGLABR13A03M4G', commands,
  usbIds: ['2c7c0800'],
  diagQos: { transport: 'adb-diag-socket', timeoutSeconds: 90 },
  unsupportedOperations: {},
  _comment: [
    '管理员可直接编辑此 JSON .conf。只支持声明式命令/解析规则，不执行文件中的脚本。升级保留用户修改。',
    '按专用AT串口的USB父设备 idVendor+idProduct 选择文件；未知ID不会套用移远配置。新增型号复制文件并修改usbIds、命令、字段规则及能力。',
    'command 为实际AT指令，{name} 由parameters中的完整正则校验。kind区分读写；规则不匹配则报错，不能将旧数据当成新确认。',
    'rules.regex筛选每行，第1捕获组为CSV正文；format=captures时各捕获组为字段。fields.index从0开始，type支持string/number/hex/boolean。',
    'map解码枚举，scale/offset转换物理单位，pattern从字段提取第1捕获组；optional/unknown处理缺值。constants补充固定语义。',
    'segments用于同一行多个括号元组；repeat用于计数+定长重复字段。使用JS与POSIX共有正则子集，不使用非捕获组/前后查找。',
    'groups.names为可合并查询的语义操作名，required是成功缓存所需操作；ttl单位秒。各controls写入后必须重新读取对应操作确认。',
    'unsupportedOperations以操作名映射不支持原因，优先于commands；可保留原命令或移除命令。不查询、不重试、不作为false/0或成功写入。接口统一status=unsupported,message=Not applicable,display=-。',
    'parameterValues列出支持的写入值，和parameters正则同时校验。例如4G型号modeSet.parameterValues.mode仅保留AUTO/LTE/WCDMA:LTE/WCDMA；不支持的5G查询/频段/锁小区操作分别声明。',
    '短信使用可选sms-tool-3gpp标准PDU传输，内部CMGF/CPMS/CMGL/CMGS由sms_tool实现；不支持标准3GPP短信的型号应移除sms能力，不能假装仅改正则即可支持私有协议。',
  ],
  contracts: {
    identity: 'manufacturer/model/revision/imei => string；必须使用modelPattern验证型号。',
    network: 'simPin.pin_required、signal.rssi_code(0..31)、operator.mode/format/operator、registration.status/registration5g.status(3GPP枚举)、provider.provider_name/plmn。MCC/MNC保持字符串前导零。',
    cells: 'serving/neighbors/carriers => tech:lte|nr、is_serving/is_secondary:boolean、state、mcc/mnc:string、cell_id/tac:十进制、arfcn/pci/band_number:number、bandwidth_mhz:MHz、rsrp/rssi:dBm、rsrq/sinr/rssnr:dB、scs:NR枚举。禁止先乘100；API兼容层统一转换。',
    bands: 'bandCapabilities => rat:lte|sa|nsa,bands:冒号分隔数字；lteBands/nrBands/nsaBands同格式。',
    locks: 'lteCellLock/nrCellLock => [{count:0}]解除，或每个小区一条{rat,arfcn,pci,scs_khz?,band?}。NR写参数scs单位kHz；写后实际回读匹配才成功。',
    scan: 'cellScan => 与cells相同物理单位、tech/mcc/mnc/arfcn/pci/rsrp/rsrq/band_number/scs；不视为服务小区。operatorScan => status:0..3,long_name/short_name/plmn/technology。',
    sim: 'iccid/imsi/sms_center:string、phone.number:string；simAdministrative/simGroup/simProvider.data为CRSM成功返回的十六进制EF文件，通用SIM标准解码由主机实现。',
    settings: 'radio.functionality映射radioStates；roamingPreference.roam_pref:1=关闭/255=允许/3=附属。mode.mode为AUTO/LTE:NR5G/LTE/NR5G/WCDMA:LTE/WCDMA。',
    apn: 'contexts => cid,protocol,apn,address；contextsActive => cid,active:boolean。wwan拨号由netifd管理，不用AT盲目激活PDP。',
    temperature: 'temperature => sensor:string,temperature:number，单位摄氏度。',
  },
  groups: {
    status: { ttl: cacheSeconds.status, names: ['simPin','signal','operator','registration','registration5g','provider'], required: ['simPin'] },
    radio: { ttl: cacheSeconds.radio, names: ['radio'] }, cells: { ttl: cacheSeconds.cells, names: ['serving','neighbors','carriers'], required: ['serving'] },
    temperature: { ttl: cacheSeconds.temperature, names: ['temperature'] }, identity: { ttl: cacheSeconds.identity, names: ['manufacturer','model','revision','imei'], required: ['model'] },
    sim: { ttl: cacheSeconds.sim, names: ['iccid','imsi','phone','smsCenter'], required: ['iccid','imsi'] }, roaming: { ttl: cacheSeconds.roaming, names: ['roamingPreference'] }, mode: { ttl: cacheSeconds.mode, names: ['mode'] },
  },
  bandOperations: { lte: { read: 'lteBands', write: 'lteBandsSet' }, sa: { read: 'nrBands', write: 'nrBandsSet' }, nsa: { read: 'nsaBands', write: 'nsaBandsSet' } },
  simAbsentPattern: 'SIM not inserted|\\+CME ERROR: *10([^0-9]|$)', simReadyValue: 'READY', radioStates: { online: 1, flight: 4, off: [0,4] },
  sms: { transport: 'sms-tool-3gpp', memories: ['ME','SM'], receiveTimeout: 12, sendTimeout: 50, sentPattern: '\\+CMGS:|[Ss][Mm][Ss] sent|[Mm]essage sent', errorPattern: 'ERROR|failed', comment: '3GPP PDU codec/CMGF/CPMS/CMGL/CMGS delegated to sms_tool; retain modem copies, archive by SIM.' },
  console: { shortcuts: [{label:'IMEI',operation:'imei',desc:'查询设备 IMEI'},{label:'ICCID',operation:'iccid',desc:'查询 SIM 卡 ICCID'},{label:'IMSI',operation:'imsi',desc:'查询 IMSI'},{label:'信号质量',operation:'signal',desc:'查询信号强度'},{label:'网络注册',operation:'registration',desc:'查询网络注册状态'},{label:'运营商',operation:'operator',desc:'查询当前运营商'}], imeiRead: 'imei', imeiWrite: 'imeiSet' },
}
