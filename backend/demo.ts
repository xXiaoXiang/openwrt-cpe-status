import type { AtTransport } from './transport.ts'
import { OpenWrtHost } from './host.ts'

// Synthetic, opt-in fixtures. Never selected when a real tty is configured.
export class DemoTransport implements AtTransport {
  commands: string[] = []
  functionality = 1
  mode = 'AUTO'
  roamPreference = 255
  plmn = 'HK Demo'
  apn = 'internet'
  bands: Record<string, string> = { lte_band: '1:3:7:8:20:28:38:40:41', nsa_nr5g_band: '1:3:28:41:77:78', nr5g_band: '1:3:28:41:77:78' }
  async exchange(command: string, _timeoutMs: number, continuation?: string) {
    this.commands.push(command)
    const replies: Record<string, string> = {
      'AT': '', 'AT+CGMI': 'Quectel', 'AT+CGMM': 'RM500Q-GL', 'AT+CGMR': 'RM500QGLABR11-DEMO', 'AT+CGSN': '000000000000000',
      'AT+CFUN?': `+CFUN: ${this.functionality}`, 'AT+CPIN?': '+CPIN: READY', 'AT+QCCID': '+QCCID: 8900000000000000000', 'AT+CIMI': '454000000000000', 'AT+CNUM': '', 'AT+CSCA?': '+CSCA: "+000",145',
      'AT+CEREG?': '+CEREG: 2,1,"DE10","5F1EA15",7', 'AT+C5GREG?': '+C5GREG: 2,4', 'AT+COPS?': `+COPS: 0,0,"${this.plmn}",7`, 'AT+CSQ': '+CSQ: 24,99',
      'AT+QENG="servingcell"': '+QENG: "servingcell","CONNECT"\r\n+QENG: "LTE","FDD",454,00,5F1EA15,12,1650,3,5,5,DE10,-99,-12,-67,11,9,230,-\r\n+QENG: "NR5G-NSA",454,00,747,-71,13,-11,627264,78,12,1',
      'AT+QENG="neighbourcell"': '+QENG: "neighbourcell intra","LTE",1650,13,-10,-95,-65,20,37,7,16,6,44',
      'AT+CGATT?': '+CGATT: 1', 'AT+CGACT?': '+CGACT: 1,1', 'AT+CGDCONT?': `+CGDCONT: 1,"IPV4V6","${this.apn}","0.0.0.0",0,0`,
      'AT+QNWPREFCFG="mode_pref"': `+QNWPREFCFG: "mode_pref",${this.mode}`, 'AT+CCLK?': '+CCLK: "26/10/23,12:00:00+32"', 'AT+QTEMP': '+QTEMP: "XO_THERM",36',
      'AT+QNWPREFCFG="roam_pref"': `+QNWPREFCFG: "roam_pref",${this.roamPreference}`,
      'AT+CMGF=0': '', 'AT+CMGL=4': '', 'AT+COPS=0': '', 'AT+COPS=?': '+COPS: (2,"HK Demo","Demo","45400",7),(1,"Other Demo","Demo2","45403",7)',
      'AT+QNWPREFCFG="ue_capability_band"': Object.entries(this.bands).map(([rat, bands]) => `+QNWPREFCFG: "${rat}",${bands}`).join('\r\n'),
    }
    for (const [rat, bands] of Object.entries(this.bands)) replies[`AT+QNWPREFCFG="${rat}"`] = `+QNWPREFCFG: "${rat}",${bands}`
    if (/^AT\+CFUN=[14]$/.test(command)) { this.functionality = Number(command.at(-1)); return '\r\nOK\r\n' }
    const preference = /^AT\+QNWPREFCFG="mode_pref",(AUTO|LTE|NR5G|LTE:NR5G)$/.exec(command)
    if (preference) { this.mode = preference[1]; return '\r\nOK\r\n' }
    const roaming = /^AT\+QNWPREFCFG="roam_pref",(1|255)$/.exec(command)
    if (roaming) { this.roamPreference = Number(roaming[1]); return '\r\nOK\r\n' }
    const band = /^AT\+QNWPREFCFG="(lte_band|nsa_nr5g_band|nr5g_band)",([\d:]+)$/.exec(command)
    if (band) { this.bands[band[1]] = band[2]; return '\r\nOK\r\n' }
    const apn = /^AT\+CGDCONT=1,"IPV4V6","([A-Za-z0-9._-]*)"$/.exec(command)
    if (apn) { this.apn = apn[1]; return '\r\nOK\r\n' }
    if (/^AT\+CMGS=\d+$/.test(command) && continuation) return '\r\n> \r\n+CMGS: 1\r\nOK\r\n'
    if (/^AT\+CMGD=\d+$/.test(command) || /^AT\+COPS=1,2,"\d{5,6}"$/.test(command)) return '\r\nOK\r\n'
    if (!(command in replies)) throw new Error('ERROR: demo has no fixture for this command')
    return `\r\n${replies[command]}\r\nOK\r\n`
  }
  async suspend<T>(work: () => Promise<T>) { return work() }
  async close() {}
}

export class DemoHost extends OpenWrtHost {
  private active = false
  override async status() { return { active: this.active, pending: false, interface: 'DEMO', l3_device: undefined, protocol: 'synthetic' } }
  override async setData(active: boolean) { this.active = active; return this.status() }
  override async ping(ipv6: boolean) { return { success: false, target: ipv6 ? '::1' : '127.0.0.1', error: 'Demo does not test modem connectivity' } }
}
