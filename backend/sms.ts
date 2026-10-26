import { csv } from './parser.ts'

export interface SmsRecord { id: number; direction: string; phone_number: string; content: string; timestamp: string; status: string; pdu?: string; decode_warning?: string }
const basic = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const extensions: Record<number, string> = { 10: '\f', 20: '^', 40: '{', 41: '}', 47: '\\', 60: '[', 61: '~', 62: ']', 64: '|', 101: '€' }
const hex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase()
const swap = (text: string) => (text.length % 2 ? text + 'F' : text).match(/../g)!.map(pair => pair[1] + pair[0]).join('')

export function encodeSms(number: string, content: string) {
  if (!/^\+?\d{3,20}$/.test(number)) throw new Error('Invalid SMS recipient')
  if (!content || content.length > 70 || /[\ud800-\udfff]/.test(content)) throw new Error('This version sends one UCS-2 SMS: 1–70 BMP characters, without emoji; multipart sending is not enabled')
  const digits = number.replace('+', '')
  const data = [...content].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
  const pdu = '00' + '01' + '00' + hex(digits.length) + (number.startsWith('+') ? '91' : '81') + swap(digits) + '00' + '08' + hex(data.length / 2) + data
  return { pdu, length: pdu.length / 2 - 1 }
}

export function decodeSms(pdu: string) {
  if (!/^(?:[0-9A-F]{2})+$/i.test(pdu)) throw new Error('Invalid SMS PDU')
  const bytes = Buffer.from(pdu, 'hex')
  let cursor = 1 + bytes[0]
  const first = bytes[cursor++]
  if (first === undefined || (first & 3) !== 0) throw new Error('Only SMS-DELIVER decoding is implemented; original PDU retained')
  const addressLength = bytes[cursor++], addressType = bytes[cursor++]
  if ((addressType & 0x70) === 0x50) throw new Error('Alphanumeric sender: original PDU retained')
  const addressBytes = Math.ceil(addressLength / 2)
  if (cursor + addressBytes + 10 > bytes.length) throw new Error('Truncated SMS PDU')
  const phone_number = (addressType === 0x91 ? '+' : '') + swap(bytes.subarray(cursor, cursor + addressBytes).toString('hex')).slice(0, addressLength)
  cursor += addressBytes
  cursor++ // PID
  const dcs = bytes[cursor++]
  const scts = [...bytes.subarray(cursor, cursor + 7)].map(value => Number(swap(hex(value))))
  cursor += 7
  const timezoneByte = bytes[cursor - 1]
  const timezoneQuarters = (timezoneByte & 7) * 10 + (timezoneByte >> 4)
  const offsetMinutes = timezoneQuarters * 15 * ((timezoneByte & 8) ? -1 : 1)
  const timestamp = new Date(Date.UTC(2000 + scts[0], scts[1] - 1, scts[2], scts[3], scts[4], scts[5]) - offsetMinutes * 60_000).toISOString()
  const count = bytes[cursor++]
  const data = bytes.subarray(cursor)
  const headerBytes = first & 0x40 ? (data[0] ?? 0) + 1 : 0
  if (headerBytes > data.length) throw new Error('Invalid SMS user data header')
  let content = ''
  if ((dcs & 0x0c) === 8) {
    if (count > data.length || (count - headerBytes) % 2) throw new Error('Truncated UCS-2 SMS')
    for (let i = headerBytes; i < count; i += 2) content += String.fromCharCode(data.readUInt16BE(i))
  } else if ((dcs & 0x0c) === 0 && !(dcs & 0x20)) {
    if (Math.ceil(count * 7 / 8) > data.length) throw new Error('Truncated GSM-7 SMS')
    let escaped = false
    for (let i = Math.ceil(headerBytes * 8 / 7); i < count; i++) {
      const bit = i * 7, index = Math.floor(bit / 8), shift = bit % 8
      const septet = ((data[index] >> shift) | ((data[index + 1] ?? 0) << (8 - shift))) & 127
      if (escaped) { content += extensions[septet] ?? '�'; escaped = false }
      else if (septet === 27) escaped = true
      else content += basic[septet] ?? '�'
    }
  } else throw new Error('Unsupported SMS encoding; original PDU retained')
  return { phone_number, content, timestamp, multipart: headerBytes > 0 }
}

export function parseSmsList(reply: string): SmsRecord[] {
  const lines = reply.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const records: SmsRecord[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('+CMGL:')) continue
    const header = csv(lines[i].slice(6).trim())
    const id = Number(header[0]), storage = Number(header[1])
    if (!Number.isSafeInteger(id) || id < 0 || !/^(?:[\da-f]{2})+$/i.test(lines[i + 1] ?? '')) throw new Error('Invalid CMGL response')
    const pdu = lines[++i]
    const record: SmsRecord = { id, direction: storage < 2 ? 'incoming' : 'outgoing', phone_number: '未知', content: '[原始 PDU]', timestamp: '', status: storage < 2 ? 'received' : 'sent', pdu }
    try {
      const decoded = decodeSms(pdu)
      Object.assign(record, decoded)
      if (decoded.multipart) record.decode_warning = '分段短信；此版本未自动重组'
    } catch (error) { record.decode_warning = String(error) }
    records.push(record)
  }
  return records
}
