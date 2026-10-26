import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeAll, SerialTransport } from '../backend/transport.ts'
import type { FileHandle } from 'node:fs/promises'
import { encodeSms, decodeSms, parseSmsList } from '../backend/sms.ts'
import { runLpac, type LpacConfig } from '../backend/lpac.ts'

test('nonblocking serial writes handle EAGAIN and partial writes without losing bytes', async () => {
  let calls = 0, output = ''
  const file = { write: async (buffer: Buffer, offset: number, length: number) => {
    if (++calls === 1) throw Object.assign(new Error('try again'), { code: 'EAGAIN' })
    const bytesWritten = Math.min(length, 2)
    output += buffer.subarray(offset, offset + bytesWritten).toString()
    return { bytesWritten, buffer }
  } } as unknown as Pick<FileHandle, 'write'>
  await writeAll(file, 'AT+CFUN?\r', Date.now() + 1000)
  assert.equal(output, 'AT+CFUN?\r')
  await assert.rejects(writeAll(file, 'AT', Date.now() - 1), /timed out/)
})

test('SMS encodes UCS-2 submission and rejects unsupported text before writing', () => {
  const result = encodeSms('+12345', '你好')
  assert.equal(result.pdu, '00010005912143F50008044F60597D')
  assert.equal(result.length, result.pdu.length / 2 - 1)
  assert.throws(() => encodeSms('+12345', '😀'), /UCS-2/)
  assert.throws(() => encodeSms('+12345', 'a'.repeat(71)), /UCS-2/)
  assert.throws(() => encodeSms('+12;AT', 'a'), /recipient/)
})

test('timed-out AT write is not retried; late OK is consumed before real confirmation query', async () => {
  const transport = new SerialTransport('/dev/ttyUSB2'), writes: string[] = []
  let queued = ''
  Object.assign(transport, { file: {
    read: async (buffer: Buffer) => { const bytesRead = buffer.write(queued); queued = ''; return { bytesRead, buffer } },
    write: async (buffer: Buffer, offset: number, length: number) => {
      const command = buffer.subarray(offset, offset + length).toString(); writes.push(command)
      if (command === 'AT+CFUN?\r') queued = '\r\n+CFUN: 4\r\nOK\r\n'
      return { bytesWritten: length, buffer }
    },
  } })
  await assert.rejects(transport.exchange('AT+CFUN=4', 1), /timed out/)
  await assert.rejects(transport.exchange('AT+CFUN?', 1), /no new command sent/)
  assert.deepEqual(writes, ['AT+CFUN=4\r'])
  queued = '\r\nOK\r\n'
  assert.match(await transport.exchange('AT+CFUN?', 100), /\+CFUN: 4/)
  assert.deepEqual(writes, ['AT+CFUN=4\r', 'AT+CFUN?\r'])
})

test('SMS-DELIVER decodes UCS-2, keeps unsupported raw PDU', () => {
  const pdu = '000005912143F5000862013221436500044F60597D'
  const result = decodeSms(pdu)
  assert.equal(result.phone_number, '+12345')
  assert.equal(result.content, '你好')
  assert.equal(result.timestamp, '2026-10-23T12:34:56.000Z')
  const records = parseSmsList('+CMGL: 1,0,,22\n' + pdu + '\n+CMGL: 2,0,,1\n0001\nOK')
  assert.equal(records[0].content, '你好')
  assert.equal(records[1].pdu, '0001')
  assert.ok(records[1].decode_warning)
  assert.throws(() => decodeSms('xyz'), /Invalid/)
})

test('LPAC subprocess parses final payload and forcibly kills a hung process', async () => {
  const config: LpacConfig = { enabled: true, executable: process.execPath, env: {}, enableRefresh: '1' }
  assert.deepEqual(await runLpac(config, ['-e', 'console.log(JSON.stringify({type:"lpa",payload:{code:0,message:"success",data:{ok:true}}}))'], 3000), { ok: true })
  const started = Date.now()
  await assert.rejects(runLpac(config, ['-e', 'setInterval(()=>{},1000)'], 100), /forcibly terminated/)
  assert.ok(Date.now() - started < 3000)
  await assert.rejects(runLpac({ ...config, enabled: false }, [], 100), /Unsupported/)
})
