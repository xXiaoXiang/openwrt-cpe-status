import type { StatusSnapshot } from '../../shared/status-snapshot.ts'

// Read-only hardware capture: R13 reports both NR enum 7 and NOCONN.
export const r13NsaCells = '+QENG: "servingcell","NOCONN"\n'
  + '+QENG: "LTE","FDD",454,00,31E7C20,323,1400,3,5,5,452,-94,-11,-60,12,7,200,-\n'
  + '+QENG: "NR5G-NSA",454,00,41,-85,14,-10,632352,78,7,1\n'
  + '+QENG: "neighbourcell inter","LTE",3349,323,-10,-108,-90,-,-,-,-,-\n'
  + '+QCAINFO: "PCC",1400,100,"LTE BAND 3",1,323,-94,-12,-60,2\n'
  + '+QCAINFO: "SCC",3349,100,"LTE BAND 7",1,323,-108,-10,-90,8,0,-,-\n'
  + '+QCAINFO: "SCC",632352,7,"NR5G BAND 78",41\n'

// R13A03 read layouts captured on hardware; subscriber/device IDs and IPs replaced.
export const r13Snapshot: StatusSnapshot = {
  source: 'quectel-sms-tool', device: '/dev/ttyUSB2', stale: false,
  sampled: { status: 1000, cells: 1000, temperature: 1000, identity: 1000, sim: 1000, roaming: 1000 },
  raw: {
    status: '+CFUN: 1\n+CPIN: READY\n+CSQ: 22,99\n+COPS: 0,2,"45400",13\n+CEREG: 0,1\n+C5GREG: 2,0\n+QSPN: "Lucky2","Lucky2","Lucky2",0,"45400"\n',
    cells: '+QENG: "servingcell","NOCONN","LTE","FDD",454,00,38C4C03,158,3125,7,4,4,22,-97,-11,-67,11,0,-,30\n'
      + '+QENG: "neighbourcell intra","LTE",3125,158,-11,-97,-67,-,30,7,18,16,58\n'
      + '+QENG: "neighbourcell intra","LTE",3125,49,-19,-106,-76,-,21,7,18,16,58\n'
      + '+QENG: "neighbourcell inter","LTE",1400,323,-15,-95,-60,-,30,6,8,22\n'
      + '+QENG: "neighbourcell inter","LTE",3349,-,-,-,-,-,21,5,8,22\n'
      + '+QCAINFO: "PCC",3125,75,"LTE BAND 7",1,158,-97,-11,-67,3\n',
    temperature: '+QTEMP:"qfe_wtr_pa0","31"\n+QTEMP:"qfe_wtr_pa1","37"\n',
    identity: 'Quectel\nRM500Q-GL\nRM500QGLABR13A03M4G\n000000000000000\n',
    sim: '+QCCID: 89000000000000000000\n001010000000000\n+CSCA: "",145\n',
    roaming: '+QNWPREFCFG: "roam_pref",255\n',
  },
  host: {
    time: 1005, previous_time: 1000, board: { kernel: '6.12.103', hostname: 'test-router', model: 'Cudy TR3000', release: { description: 'ImmortalWrt 25.12.2' } },
    net: { up: true, proto: 'mbim', l3_device: 'wwan0', uptime: 4511, 'ipv4-address': [{ address: '192.0.2.2', mask: 30 }], 'ipv6-address': [{ address: '2001:db8::2', mask: 64 }] },
    meminfo: 'MemTotal: 200000 kB\nMemFree: 50000 kB\nMemAvailable: 100000 kB\nCached: 40000 kB\nBuffers: 10000 kB',
    loadavg: '0.20 0.30 0.10 1/100 200', uptime: '90061.0 1000.0', cpustat: 'cpu 1 2 3\ncpu0 1 2 3\ncpu1 1 2 3',
    cpuinfo: '', machine: 'aarch64', disk: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 10000 4000 6000 40% /',
    counters: [{ interface: 'wwan0', rx: 20000, tx: 6000 }], previous_counters: [{ interface: 'wwan0', rx: 10000, tx: 1000 }],
    thermal: [{ zone: 'thermal_zone0', type: 'cpu-thermal', temperature: 52 }],
  },
}
