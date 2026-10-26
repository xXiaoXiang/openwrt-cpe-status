import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionFromHost, interfaceAliases, type HostNetwork } from '../shared/host-network.ts'
import { defaultSpeedInterfaces, readSpeedSelection, speedInterfaceSelected } from '../frontend/src/utils/speedInterfaces.ts'

const host = (): HostNetwork => ({
  network_interface: 'wwan', net: { up: true, proto: 'mbim', l3_device: 'wwan0', uptime: 60 },
  networks: [
    { interface: 'wwan_4', dynamic: true, up: true, l3_device: 'wwan0', 'ipv4-address': [{ address: '192.0.2.2', mask: 26 }] },
    { interface: 'wwan_6', dynamic: true, up: true, l3_device: 'wwan0', 'ipv6-address': [{ address: '2001:db8::2', mask: 64 }], 'ipv6-prefix': [{ address: '2001:db8:100::', mask: 56 }] },
    { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [{ address: '192.168.60.1', mask: 24 }] },
    { interface: 'other_4', up: true, l3_device: 'wwan1', 'ipv4-address': [{ address: '198.51.100.2', mask: 24 }] },
  ],
})

test('MBIM children contribute addresses/PD while parent retains protocol/device/uptime', () => {
  const value = host(), result = connectionFromHost(value)
  assert.equal(result.protocol, 'MBIM')
  assert.equal(result.interface, 'wwan0')
  assert.equal(result.uptime_seconds, 60)
  assert.deepEqual(result.ipv4, ['192.0.2.2/26'])
  assert.deepEqual(result.ipv6, ['2001:db8::2/64'])
  assert.deepEqual(result.ipv6_prefix, ['2001:db8:100::/56'])
  value.net['ipv4-address'] = [{ address: '192.0.2.2', mask: 26 }]
  assert.deepEqual(connectionFromHost(value).ipv4, ['192.0.2.2/26'])
  value.networks![0].up = false
  value.net['ipv4-address'] = []
  assert.deepEqual(connectionFromHost(value).ipv4, [])
})

test('kernel address fallback excludes link-local/tentative IPv6 and never invents PD', () => {
  const value = host()
  value.networks = []
  value.device_addresses = '9: wwan0 inet 192.0.2.8/26 brd 192.0.2.63 scope global wwan0\n'
    + '9: wwan0 inet6 fe80::1/64 scope link\n'
    + '9: wwan0 inet6 2001:db8::8/64 scope global\n'
    + '9: wwan0 inet6 2001:db8::9/64 scope global tentative\n'
  assert.deepEqual(connectionFromHost(value).ipv4, ['192.0.2.8/26'])
  assert.deepEqual(connectionFromHost(value).ipv6, ['2001:db8::8/64'])
  assert.deepEqual(connectionFromHost(value).ipv6_prefix, [])
  value.net.up = false
  assert.deepEqual(connectionFromHost(value).ipv4, [])
  assert.deepEqual(connectionFromHost(value).ipv6, [])
})

test('logical interface aliases select real devices and browser preferences preserve empty selections', () => {
  const aliases = interfaceAliases(host(), 'wwan0')
  assert.deepEqual(aliases, ['wwan', 'wwan_4', 'wwan_6'])
  assert.equal(speedInterfaceSelected({ interface: 'wwan0', logical_interfaces: aliases }, defaultSpeedInterfaces), true)
  assert.equal(speedInterfaceSelected({ interface: 'br-lan' }, defaultSpeedInterfaces), true)
  assert.equal(speedInterfaceSelected({ interface: 'eth0' }, defaultSpeedInterfaces), false)
  assert.deepEqual(readSpeedSelection(null), defaultSpeedInterfaces)
  assert.deepEqual(readSpeedSelection('invalid'), defaultSpeedInterfaces)
  assert.deepEqual(readSpeedSelection('[]'), [])
  assert.deepEqual(readSpeedSelection('["eth0","eth0"]'), ['eth0'])
})

test('WAN IPv6 display excludes ULA/link-local addresses and prefixes from all sources', () => {
  const value = host(), child = value.networks![1]
  child['ipv6-address'] = [{ address: 'fd12:3456::2', mask: 64 }, { address: 'fe80::1', mask: 64 }]
  child['ipv6-prefix'] = [{ address: 'fd12:3456::', mask: 56 }]
  value.device_addresses = '9: wwan0 inet6 fd12:3456::2/64 scope global\n'
  assert.deepEqual(connectionFromHost(value).ipv6, [])
  assert.deepEqual(connectionFromHost(value).ipv6_prefix, [])
  child['ipv6-address'].push({ address: '2408:1234::2', mask: 64 })
  child['ipv6-prefix'].push({ address: '2408:1234:100::', mask: 56 })
  assert.deepEqual(connectionFromHost(value).ipv6, ['2408:1234::2/64'])
  assert.deepEqual(connectionFromHost(value).ipv6_prefix, ['2408:1234:100::/56'])
})
