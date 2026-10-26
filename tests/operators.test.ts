import { parseReply } from '../backend/parser.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOperators as normalizeResult } from '../shared/operators.ts'
function parseOperators(raw: string) {
  if (!/^\s*OK\s*$/m.test(raw) || /^\s*(ERROR|\+CME ERROR:)/m.test(raw)) throw new Error('扫描未完整结束')
  try { return normalizeResult(raw, parseReply(rm500qProfile.commands.operatorScan, raw)) } catch (error) { throw new Error('扫描格式无法识别：' + error) }
}

test('operator scan preserves PLMN, aliases and RATs without confusing capability tuples', () => {
  const rows = parseOperators('+COPS: (1,"CUniq (3HK)","CUniq","45403",7),(2,"UNICOM, HK","UNICOM","45400",7),(1,"CUniq","CUniq","45403",11),(3,"CTM","CTM","45501",7),,(0-4),(0-2)\r\nOK\r\n')
  assert.deepEqual(rows.map(row => row.plmn), ['45400', '45403', '45501'])
  assert.deepEqual(rows[1].technologies, ['LTE', 'NR'])
  assert.equal(rows[0].names[0], 'UNICOM, HK')
  assert.equal(rows[2].status, 3)
})
test('same names on different PLMNs stay separate; leading zero MNC remains intact', () => {
  assert.deepEqual(parseOperators('+COPS: (1,"TEST","TEST","00101",7),(1,"TEST","TEST","001001",7)\nOK\n').map(row => row.plmn), ['001001', '00101'])
})
test('partial or rejected scan cannot replace a successful list', () => {
  assert.throws(() => parseOperators('+COPS: (1,"A","A","45400",7)'))
  assert.throws(() => parseOperators('+CME ERROR: 30\nOK\n'))
  assert.deepEqual(parseOperators('+COPS: ,,(0-4),(0-2)\nOK\n'), [])
})
