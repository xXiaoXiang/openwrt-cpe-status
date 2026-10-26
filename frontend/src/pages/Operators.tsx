import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material'
import { SettingsInputAntenna } from '@mui/icons-material'
import ApnSettings from '../components/ApnSettings'
import { request } from '../api/request'
import { useCapabilities } from '../contexts/CapabilitiesContext'
import { useSharedDashboardData } from '../contexts/DashboardDataContext'
import { getCarrierInfo } from '../utils/carriers'
import { parseOperators, type OperatorNetwork, type OperatorResult, type OperatorState } from '../../../shared/operators.ts'

type Selection = { action: 'scan' | 'auto' | 'manual'; plmn?: string; name?: string }
const labels = ['未知', '可用', '当前', '禁止']
export default function Operators() {
  const capabilities = useCapabilities(), writable = capabilities?.writes_enabled === true
  const { data: dashboard } = useSharedDashboardData()
  const [state, setState] = useState<OperatorState>()
  const [showNetworks, setShowNetworks] = useState(false)
  const [networks, setNetworks] = useState<OperatorNetwork[]>([])
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false)
  const [loadingState, setLoadingState] = useState(true)
  const [confirmation, setConfirmation] = useState<Selection>()
  const [notice, setNotice] = useState<{ severity: 'info' | 'error' | 'success'; text: string }>()
  const searched = useRef(false), operationRevision = useRef(0)
  const mounted = useRef(true), pending = useRef(false), submitting = useRef(false)
  const consume = useCallback((result: OperatorResult, currentOnly = false) => {
    if (!mounted.current) return
    if (result.state) setState(result.state)
    if (result.data && searched.current) setNetworks(parseOperators(result.data.raw, result.data.records))
    setBusy(result.busy === true)
    if (result.message && (!currentOnly || result.status === 'error')) setNotice({ severity: result.busy || result.status === 'deferred' ? 'info' : result.status === 'error' ? 'error' : 'success', text: result.message })
  }, [])
  const read = useCallback(async (refresh = false, currentOnly = false) => {
    if (pending.current || submitting.current) return
    const revision = operationRevision.current
    pending.current = true; setReading(true)
    try {
      const result = await request<OperatorResult>(currentOnly ? refresh ? '/operators/current' : '/operators/current-result' : refresh ? '/operators/refresh' : '/operators')
      if (revision !== operationRevision.current) return
      if (currentOnly && mounted.current) setLoadingState(result.refreshing === true || (!result.state && result.status !== 'error'))
      consume(result, currentOnly)
      return result
    } catch (error) { if (mounted.current) setNotice({ severity: 'error', text: String(error) }) }
    finally { pending.current = false; if (mounted.current) setReading(false) }
  }, [consume])
  useEffect(() => {
    mounted.current = true
    // Finite initial fill; thereafter poll files only while a submitted job runs.
    const revision = operationRevision.current
    void (async () => {
      for (let i = 0; i < 12 && mounted.current && revision === operationRevision.current; i++) {
        const result = await read(i === 0, true)
        if (result?.busy || (result?.state && i > 0 && !result.refreshing) || result?.status === 'error') break
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      if (mounted.current && revision === operationRevision.current) setLoadingState(false)
    })()
    return () => { mounted.current = false }
  }, [read])
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void read(), 2000)
    return () => clearInterval(timer)
  }, [busy, read])
  const apply = async () => {
    if (!confirmation || !writable || submitting.current) return
    operationRevision.current++
    const selection = confirmation
    if (selection.action === 'scan') { searched.current = true; setShowNetworks(true) }
    setConfirmation(undefined); submitting.current = true; setBusy(true); setNotice(undefined)
    try { consume(await request<OperatorResult>('/operators', { method: 'POST', body: JSON.stringify(selection) })) }
    catch (error) { if (mounted.current) { setBusy(false); setNotice({ severity: 'error', text: String(error) }) } }
    finally { submitting.current = false }
  }
  const refreshState = async () => {
    setLoadingState(true)
    const before = state?.sampled_at ?? 0
    for (let i = 0; i < 12 && mounted.current; i++) {
      const result = await read(i === 0, true)
      if (result?.busy || (result?.state && result.state.sampled_at > before) || result?.status === 'error') break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    if (mounted.current) setLoadingState(false)
  }
  const plmn = state?.plmn || ''
  const isName = (value?: string) => !!value?.trim() && !/^[\d\s/-]+$/.test(value.trim())
  const scannedName = networks.find(row => row.plmn === plmn)?.names.find(isName)
  const network = dashboard.networkInfo
  const sharedName = network && `${network.mcc ?? ''}${network.mnc ?? ''}` === plmn && isName(network.operator_name) ? network.operator_name : undefined
  const carrier = /^\d{5,6}$/.test(plmn) ? getCarrierInfo(plmn.slice(0, 3), plmn.slice(3)) : null
  const operatorName = (isName(state?.operator) ? state?.operator : undefined) || scannedName || sharedName || carrier?.operatorCn || '运营商名称待确认'
  const registrationLabel = state?.registered ? state.mode === 0 ? '已自动注册上网络' : state.mode === 1 ? '已手动注册上网络' : '已注册' : '尚未确认注册'
  return <Stack spacing={2} data-operators>
    <Box display="flex" alignItems="center" gap={1} flexWrap="wrap"><SettingsInputAntenna color="primary" /><Typography variant="h6" flex={1}>运营商与APN设置</Typography>
      <Button disabled={busy || reading || loadingState} onClick={() => void refreshState()}>读取状态</Button>
    </Box>
    <Paper variant="outlined" sx={{ p: 2 }}><Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
      {loadingState ? <CircularProgress size={20} aria-label="读取当前运营商" /> : <>
      <Typography data-current-operator title={plmn}>{state ? operatorName : '—'}</Typography>
      <Chip data-operator-registration variant="outlined" color={state?.registered ? 'success' : 'default'} label={registrationLabel} />
      {state && !state.registered && <Chip label={state.mode === 0 ? '自动选网' : state.mode === 1 ? '手动选网' : `选网模式 ${state.mode}`} />}
      </>}
    </Stack></Paper>
    <ApnSettings />
    <Typography variant="h6">手动选择运营商</Typography>
    <Box display="flex" gap={1} flexWrap="wrap"><Button variant="contained" disabled={!writable || busy} onClick={() => setConfirmation({ action: 'scan' })}>扫描运营商</Button>
      <Button variant="outlined" disabled={!writable || busy} onClick={() => setConfirmation({ action: 'auto' })}>自动选网</Button>
      {busy && <CircularProgress size={24} />}
    </Box>
    <Typography variant="body2" color="text.secondary">扫描或重新注册可能短暂影响数据连接，最长需要数分钟。</Typography>
    {!writable && capabilities && <Alert severity="info">当前 LuCI 会话为只读。</Alert>}
    {notice && <Alert severity={notice.severity} onClose={() => setNotice(undefined)}>{notice.text}</Alert>}
    {showNetworks && <TableContainer component={Paper} variant="outlined"><Table size="small" sx={{ minWidth: 460 }}><TableHead><TableRow>{['运营商', 'PLMN', '网络类型', '扫描状态', '操作'].map(label => <TableCell key={label} sx={{ whiteSpace: 'nowrap' }}>{label}</TableCell>)}</TableRow></TableHead>
      <TableBody>{networks.map(row => <TableRow key={row.plmn} data-operator-plmn={row.plmn}><TableCell>{row.names.join(' / ') || row.plmn}</TableCell><TableCell>{row.plmn}</TableCell><TableCell>{row.technologies.join(' / ') || '—'}</TableCell><TableCell>{labels[row.status]}</TableCell>
        <TableCell><Button size="small" disabled={!writable || busy} onClick={() => setConfirmation({ action: 'manual', plmn: row.plmn, name: row.names[0] })}>选择</Button></TableCell>
      </TableRow>)}{!networks.length && <TableRow><TableCell colSpan={5}>点击“扫描运营商”获取可用网络。</TableCell></TableRow>}</TableBody></Table></TableContainer>}
    <Dialog open={!!confirmation} onClose={() => setConfirmation(undefined)} fullWidth maxWidth="sm"><DialogTitle>{confirmation?.action === 'scan' ? '扫描可用运营商？' : confirmation?.action === 'auto' ? '恢复自动选网？' : '手动注册到所选运营商？'}</DialogTitle>
      <DialogContent><Typography>{confirmation?.action === 'manual' ? `${confirmation.name || ''} · ${confirmation.plmn}。手动选网失败时不会自动切换到其他运营商，可使用“自动选网”恢复。` : confirmation?.action === 'scan' ? '扫描可能需要1至3分钟，期间蜂窝数据可能暂时不可用。' : '由模块自动选择允许注册的运营商。'}</Typography>
        <Typography mt={1}>操作期间保留当前显示，仅在模块回读确认注册后报告成功。</Typography></DialogContent>
      <DialogActions><Button onClick={() => setConfirmation(undefined)}>取消</Button><Button variant="contained" onClick={() => void apply()}>确认</Button></DialogActions>
    </Dialog>
  </Stack>
}
