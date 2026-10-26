import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm500q } from '../adapters/quectel-rm500q-gl-r11.ts'
import { csv, parseReply, renderCommand } from '../backend/parser.ts'
import { normalizeCells } from '../backend/cells.ts'
import { validateAdapter, identify } from '../backend/engine.ts'
import { DemoTransport } from '../backend/demo.ts'
import { getCellTechnologyLabel, getCellFrequencyLabel } from '../frontend/src/utils/cells.ts'
import type { CellsResponse } from '../frontend/src/api/types.ts'

const parse = (reply: string) => parseReply(rm500q.commands.serving, reply)
const lte = '+QENG: "LTE","FDD",460,01,5F1EA15,12,1650,3,5,5,DE10,-99,-12,-67,11,9,230,-'
const nr = '+QENG: "NR5G-NSA",460,01,747,-71,13,-11,627264,78,12,1'

test('official LTE example preserves PLMN leading zeros and converts units/BW', () => {
  const [row] = parse(lte.replace('"LTE","FDD"', '"servingcell","CONNECT","LTE","FDD"'))
  assert.equal(row.mnc, '01')
  assert.equal(row.cell_id, 0x5F1EA15)
  assert.equal(row.tac, 0xDE10)
  assert.equal(row.bandwidth_mhz, 20)
  assert.equal(row.sinr, 2)
  const result = normalizeCells([row], [])
  assert.equal(result.technology, 'LTE')
  assert.equal(result.cells[0].rsrp, -9900)
  assert.equal(result.cells[0].band, 'B3')
})

test('NSA merges LTE primary and NR secondary; NR bandwidth retains RRC validity', () => {
  const result = normalizeCells(parse('+QENG: "servingcell","CONNECT"\n' + lte + '\n' + nr), [])
  assert.equal(result.technology, 'ENDC')
  assert.equal(result.cells.length, 2)
  assert.equal(result.cells[1].band, 'n78')
  assert.equal(result.cells[1].bandwidth_mhz, 100)
  assert.equal(result.cells[1].sinr, 1300)
  assert.equal(result.cells[1].nrarfcn, 627264)
  const snapshot = result as unknown as CellsResponse
  assert.equal(getCellTechnologyLabel(snapshot), 'LTE/NR')
  assert.equal(getCellFrequencyLabel(snapshot), '(NR) ARFCN')
  const idle = normalizeCells(parse('+QENG: "servingcell","NOCONN"\n' + lte + '\n' + nr), []).cells[1]
  assert.equal(idle.bandwidth_mhz, 100)
  assert.equal(idle.bandwidth_current, false)
})

test('zero/unknown NR rows never invent a secondary connection', () => {
  for (const secondary of ['+QENG: "NR5G-NSA",0,00,0,0,0,0,0,0,0,0', '+QENG: "NR5G-NSA",460,01,747,-32768,-32768,-32768,0,0,-,1']) {
    const result = normalizeCells(parse(lte + '\n' + secondary), [])
    assert.equal(result.technology, 'LTE')
    assert.equal(result.cells.length, 1)
  }
  assert.equal(getCellTechnologyLabel({ serving_cell: null, cells: [] }), '-')
})

test('official SA example uses separate indexes and NRARFCN header', () => {
  const result = normalizeCells(parse('+QENG: "servingcell","CONNECT","NR5G-SA","TDD",460,01,9013B004,299,690E0F,633984,78,12,-107,-13,2,1,-'), [])
  assert.equal(result.technology, 'NR')
  assert.equal(result.serving_cell?.cell_id, 0x9013B004)
  assert.equal(result.serving_cell?.tac, 0x690E0F)
  assert.equal(result.cells[0].bandwidth_mhz, 100)
  assert.equal(result.cells[0].rsrp, -10700)
  assert.equal(getCellFrequencyLabel(result as unknown as CellsResponse), 'NRARFCN')
})

test('all RM500Q NR width enums reach SA/NSA output; unavailable widths preserve cells', () => {
  const widths = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 200, 400]
  for (const [code, mhz] of widths.entries()) {
    const nsa = '+QENG: "servingcell","CONNECT"\n' + lte + '\n' + nr.replace(',78,12,1', `,78,${code},1`)
    const sa = `+QENG: "servingcell","CONNECT","NR5G-SA","TDD",460,01,9013B004,299,690E0F,633984,78,${code},-107,-13,2,1,-`
    for (const [reply, index] of [[nsa, 1], [sa, 0]] as const) {
      const cell = normalizeCells(parse(reply), []).cells[index]
      assert.equal(cell.bandwidth_mhz, mhz)
      assert.equal(cell.bandwidth_code, code)
      assert.equal(cell.rrc_state, 'CONNECT')
      assert.equal(cell.scs, 1)
      const idle = normalizeCells(parse(reply.replace('CONNECT', 'NOCONN')), []).cells[index]
      assert.equal(idle.bandwidth_mhz, mhz)
      assert.equal(idle.bandwidth_current, false)
      assert.equal(cell.bandwidth_current, true)
    }
  }
  for (const unavailable of ['-', '255', '65535', '-32768']) {
    const sa = `+QENG: "servingcell","CONNECT","NR5G-SA","TDD",460,01,9013B004,299,690E0F,633984,78,${unavailable},-107,-13,2,1,-`
    const cell = normalizeCells(parse(sa), []).cells[0]
    assert.equal(cell.bandwidth_mhz, null)
    assert.equal(cell.rsrp, -10700)
    const nsa = '+QENG: "servingcell","CONNECT"\n' + lte + '\n' + nr.replace(',78,12,1', `,78,${unavailable},1`)
    assert.equal(normalizeCells(parse(nsa), []).cells[1].bandwidth_mhz, null)
  }
  const missing = nr.slice(0, nr.indexOf(',78,12,1')) + ',78'
  assert.equal(normalizeCells(parse('+QENG: "servingcell","CONNECT"\n' + lte + '\n' + missing), []).cells[1].bandwidth_mhz, null)
})

test('CSV preserves quoted commas/empty values; malformed fields reject', () => {
  assert.deepEqual(csv('1,"a,b",,"x""y"'), ['1', 'a,b', '', 'x"y'])
  assert.throws(() => csv('"unfinished'), /Unterminated/)
  assert.throws(() => parse(lte.replace(',12,1650', ',bad,1650')), /numeric/)
  assert.throws(() => parse(lte.replace(',3,5,5,DE10', ',3,5,9,DE10')), /enum/)
})

test('write templates reject injected commands and invalid parameters', () => {
  assert.equal(renderCommand(rm500q.commands.operatorManual, { plmn: '45400' }), 'AT+COPS=1,2,"45400"')
  assert.throws(() => renderCommand(rm500q.commands.operatorManual, { plmn: '45400";AT+CFUN=4' }), /Invalid parameter/)
  assert.throws(() => renderCommand(rm500q.commands.apnSet, { cid: '1', protocol: 'IP', apn: 'internet\rAT' }), /Invalid parameter/)
  assert.throws(() => renderCommand(rm500q.commands.bandSet, { rat: 'lte_band', bands: '0' }), /Invalid parameter/)
})

test('adapter survives runtime JSON serialization; model selection rejects unknown/ambiguous', async () => {
  validateAdapter(JSON.parse(JSON.stringify(rm500q)))
  assert.throws(() => validateAdapter({ ...rm500q, schemaVersion: 2 }), /header/)
  const transport = new DemoTransport()
  assert.equal((await identify(transport, [rm500q])).adapter.id, rm500q.id)
  await assert.rejects(identify(transport, []), /Unknown or ambiguous/)
  await assert.rejects(identify(transport, [rm500q, rm500q]), /ambiguous/)
})
