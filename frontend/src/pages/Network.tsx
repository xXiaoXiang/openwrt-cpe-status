import { useEffect, useState } from 'react'
import { Alert, Box, Button, Card, CardContent, Chip, MenuItem, Stack, Tab, Tabs, TextField, Typography } from '@mui/material'
import { request } from '@/api/request'
import { useCapabilities } from '@/contexts/CapabilitiesContext'
import { CellInfo } from './Dashboard/components/CellInfo'
import type { ApiResponse, CellsResponse, OperatorInfo } from '@/api/types'

interface Bands { lte: number[]; nsa: number[]; sa: number[]; supported: Record<string, number[]>; saved_baseline: unknown }
interface ApnContext { path: string; cid: number; access_point_name: string; protocol: string }
export default function Network() {
  const caps = useCapabilities()
  const [tab, setTab] = useState(0), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [cells, setCells] = useState<CellsResponse | null>(null)
  const [apns, setApns] = useState<ApnContext[]>([])
  const [operators, setOperators] = useState<OperatorInfo[]>([])
  const [bands, setBands] = useState<Bands | null>(null)
  const [bandText, setBandText] = useState({ lte: '', nsa: '', sa: '' })
  const [cid, setCid] = useState('1'), [apn, setApn] = useState(''), [protocol, setProtocol] = useState('dual'), [mode, setMode] = useState('auto')
  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await request<ApiResponse<T>>(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    if (response.status === 'deferred') throw new Error('Modem 正忙，保留上次结果，请稍后重试')
    if (response.status !== 'ok' || response.data === undefined) throw new Error(response.message)
    return response.data
  }
  const load = async (current: number) => {
    if (current === 0) setCells(await call<CellsResponse>('/cells'))
    if (current === 1) setApns((await call<{ contexts: ApnContext[] }>('/apn')).contexts)
    if (current === 2) setOperators((await call<{ operators: OperatorInfo[] }>('/network/operators')).operators)
    if (current === 3) {
      const result = await call<Bands>('/band-lock'); setBands(result)
      setBandText({ lte: result.lte.join(':'), nsa: result.nsa.join(':'), sa: result.sa.join(':') })
      setMode((await call<{ mode: string }>('/radio-mode')).mode)
    }
  }
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setMessage(null)
    try { await work() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  useEffect(() => { void run(() => load(tab)) }, [tab]) // Explicit page/tab refresh; no expensive scan timer.
  const mutation = (prompt: string, work: () => Promise<unknown>) => { if (window.confirm(prompt)) void run(work) }
  const disabled = busy || !caps?.writes_enabled
  return <Stack spacing={2}>
    <Tabs value={tab} onChange={(_, value: number) => setTab(value)} variant="scrollable" scrollButtons="auto">
      {['小区信息', 'APN', '运营商', '制式与频段'].map(label => <Tab key={label} label={label} />)}
    </Tabs>
    {message && <Alert severity="info" onClose={() => setMessage(null)}>{message}</Alert>}
    <Box><Button disabled={busy} onClick={() => void run(() => load(tab))}>{busy ? '处理中…' : '刷新当前标签'}</Button></Box>
    {tab === 0 && <CellInfo cellsInfo={cells} stale={busy} />}
    {tab === 1 && <Card><CardContent><Stack spacing={2}>
      <Alert severity="info">这里修改 Modem 的 PDP APN。QMI/MBIM 拨号使用的 APN、用户名和密码仍由 OpenWrt「网络 → 接口」管理。</Alert>
      {apns.map(context => <Chip key={context.path} label={`CID ${context.cid} · ${context.access_point_name} · ${context.protocol}`} onClick={() => { setCid(String(context.cid)); setApn(context.access_point_name); setProtocol(context.protocol) }} />)}
      <TextField label="CID" value={cid} onChange={event => setCid(event.target.value)} />
      <TextField label="APN" value={apn} onChange={event => setApn(event.target.value)} />
      <TextField select label="协议" value={protocol} onChange={event => setProtocol(event.target.value)}>{[['dual', 'IPv4 / IPv6'], ['ip', 'IPv4'], ['ipv6', 'IPv6']].map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
      <Button disabled={disabled} onClick={() => mutation('确认修改 Modem PDP APN？活动连接可能受到影响。', async () => { await call('/apn', { cid, apn, protocol }); await load(tab); setMessage('Modem APN 已确认保存，请核对 OpenWrt 拨号配置。') })}>保存并读取确认</Button>
    </Stack></CardContent></Card>}
    {tab === 2 && <Card><CardContent><Stack spacing={2}>
      <Typography>扫描运营商可能需要1～3分钟，扫描期间其他 AT 查询会避让。</Typography>
      <Button disabled={busy} onClick={() => void run(async () => setOperators((await call<{ operators: OperatorInfo[] }>('/network/operators/scan')).operators))}>扫描运营商</Button>
      <Button disabled={disabled} onClick={() => mutation('确认恢复自动选网？注册可能需要1～2分钟。', async () => { await call('/network/register-auto', {}); setMessage('自动选网命令已完成，请等待注册网络。') })}>自动选网</Button>
      {operators.map((operator, index) => <Button key={`${operator.path}-${index}`} disabled={disabled || operator.status === 'forbidden'} onClick={() => mutation(`确认手动选择 ${operator.name} (${operator.mcc}${operator.mnc})？此选择会保留至恢复自动选网。`, () => call('/network/register-manual', { mccmnc: operator.mcc + operator.mnc }))}>{operator.name} · {operator.mcc}{operator.mnc} · {operator.status}</Button>)}
    </Stack></CardContent></Card>}
    {tab === 3 && <Card><CardContent><Stack spacing={2}>
      <TextField select label="制式偏好" value={mode} onChange={event => setMode(event.target.value)}>{[['auto', '自动'], ['lte', '仅 LTE'], ['nr', '仅 NR SA'], ['mixed', '混合（当前值）']].map(([value, label]) => <MenuItem key={value} value={value} disabled={value === 'mixed'}>{label}</MenuItem>)}</TextField>
      <Button disabled={disabled || mode === 'mixed'} onClick={() => mutation('确认修改网络制式？可能临时断网。', () => call('/radio-mode', { mode }))}>应用制式并确认</Button>
      {(['lte', 'nsa', 'sa'] as const).map((key, index) => <TextField key={key} label={['LTE 频段', 'NR NSA 频段', 'NR SA 频段'][index]} value={bandText[key]} onChange={event => setBandText(previous => ({ ...previous, [key]: event.target.value }))} helperText={`用冒号分隔；模块能力：${bands?.supported[['lte_band', 'nsa_nr5g_band', 'nr5g_band'][index]]?.join(', ') ?? '-'}`} />)}
      <Button disabled={disabled || !bands} onClick={() => mutation('确认设置频段？NSA 和 SA 分别配置，过程中可能断网。', async () => { await call('/band-lock', Object.fromEntries(Object.entries(bandText).map(([key, value]) => [key, value.split(':').map(Number)]))); await load(tab) })}>应用频段并读取确认</Button>
      <Button disabled={disabled || !bands?.saved_baseline} onClick={() => mutation('确认恢复首次锁频前保存的频段集合？', async () => { await call('/band-lock', { operation: 'restore' }); await load(tab) })}>恢复锁频前配置</Button>
    </Stack></CardContent></Card>}
  </Stack>
}
