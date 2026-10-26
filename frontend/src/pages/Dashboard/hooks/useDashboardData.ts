/*
 * @Author: 1orz cloudorzi@gmail.com
 * @Date: 2025-12-10 10:15:57
 * @LastEditors: 1orz cloudorzi@gmail.com
 * @LastEditTime: 2025-12-13 12:44:40
 * @FilePath: /udx710-backend/frontend/src/pages/Dashboard/hooks/useDashboardData.ts
 * @Description:
 *
 * Copyright (c) 2025 by 1orz, All Rights Reserved.
 */
import { useState, useCallback, useRef } from 'react'
import { api } from '@/api'
import { useApiRequests } from '@/hooks/useApiRequests'
import { isDeferredMessage, isDeferredResponse } from '@/api/modemPolling'
import { readDeferredControl } from '@/api/controlStatus'
import { mergeNetworkInfo } from '../utils'
import {
  getAdaptiveRefreshInterval,
  useAdaptivePolling,
  usePageVisibility,
} from '@/hooks/useAdaptivePolling'
import type {
  DeviceInfo,
  NetworkInfo,
  CellsResponse,
  QosInfo,
  SimInfo,
  SystemStatsResponse,
  AirplaneModeResponse,
  ImsStatusResponse,
  RoamingResponse,
  ApiResponse,
} from '@/api/types'

export const SPEED_HISTORY_MAX_POINTS = 30

export interface InterfaceSpeedHistory {
  rx: number[]
  tx: number[]
  totalRx: number
  totalTx: number
}

export interface ConnectivityResult {
  ipv4: { success: boolean; latency_ms?: number }
  ipv6: { success: boolean; latency_ms?: number }
}

export interface DashboardData {
  deviceInfo: DeviceInfo | null
  simInfo: SimInfo | null
  systemStats: SystemStatsResponse | null
  networkInfo: NetworkInfo | null
  dataStatus: boolean | null
  cellsInfo: CellsResponse | null
  cellsStale: boolean
  qosInfo: QosInfo | null
  airplaneMode: AirplaneModeResponse | null
  imsStatus: ImsStatusResponse | null
  connectivity: ConnectivityResult | null
  speedHistory: Record<string, InterfaceSpeedHistory>
  roaming: RoamingResponse | null
}

export interface DashboardActions {
  toggleData: (target?: boolean) => Promise<void>
  toggleAirplaneMode: (target?: boolean) => Promise<void>
  toggleRoaming: (target?: boolean) => Promise<void>
  loadData: () => Promise<void>
}

export interface PendingControl {
  control: 'data' | 'airplane' | 'roaming'
  target: boolean
}

const CONNECTIVITY_MIN_REFRESH_INTERVAL = 15_000
const CONNECTIVITY_HIDDEN_MIN_REFRESH_INTERVAL = 60_000

export function useDashboardData(refreshInterval: number, refreshKey: number, dashboardActive = true) {
  const { initialLoading, error, setError, fetchInto, waitingMessage, waiting } = useApiRequests()

  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [simInfo, setSimInfo] = useState<SimInfo | null>(null)
  const [systemStats, setSystemStats] = useState<SystemStatsResponse | null>(null)
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null)
  const [dataStatus, setDataStatus] = useState<boolean | null>(null)
  const [cellsInfo, setCellsInfo] = useState<CellsResponse | null>(null)
  const [qosInfo, setQosInfo] = useState<QosInfo | null>(null)
  const [airplaneMode, setAirplaneMode] = useState<AirplaneModeResponse | null>(null)
  const [imsStatus, setImsStatus] = useState<ImsStatusResponse | null>(null)
  const [connectivity, setConnectivity] = useState<ConnectivityResult | null>(null)
  const [roaming, setRoaming] = useState<RoamingResponse | null>(null)
  const [pendingControl, setPendingControl] = useState<PendingControl | null>(null)
  const pendingControlRef = useRef<PendingControl | null>(null)
  const controlRevision = useRef(0)

  const [speedHistory, setSpeedHistory] = useState<Record<string, InterfaceSpeedHistory>>({})
  const speedHistoryRef = useRef<Record<string, InterfaceSpeedHistory>>({})

  const updateSpeedHistory = useCallback((stats: SystemStatsResponse | null) => {
    if (!stats?.network_speed?.interfaces) return

    const newHistory = { ...speedHistoryRef.current }

    for (const iface of stats.network_speed.interfaces) {
      const existing = newHistory[iface.interface] || { rx: [], tx: [], totalRx: 0, totalTx: 0 }

      const rxHistory = [...existing.rx, iface.rx_bytes_per_sec]
      const txHistory = [...existing.tx, iface.tx_bytes_per_sec]

      if (rxHistory.length > SPEED_HISTORY_MAX_POINTS) {
        rxHistory.shift()
        txHistory.shift()
      }

      newHistory[iface.interface] = {
        rx: rxHistory,
        tx: txHistory,
        totalRx: iface.total_rx_bytes,
        totalTx: iface.total_tx_bytes,
      }
    }

    speedHistoryRef.current = newHistory
    setSpeedHistory(newHistory)
  }, [])

  const isPageVisible = usePageVisibility()
  const connectivityRefreshInterval = getAdaptiveRefreshInterval(
    refreshInterval > 0 ? Math.max(refreshInterval, CONNECTIVITY_MIN_REFRESH_INTERVAL) : 0,
    isPageVisible,
    {
      hiddenMinInterval: CONNECTIVITY_HIDDEN_MIN_REFRESH_INTERVAL,
      hiddenMultiplier: 4,
    }
  )

  const loadData = useCallback(async () => {
    const revision = controlRevision.current
    const applyControl = <T,>(apply: (data: T) => void) => (data: T) => {
      // A polling response started before/during a write must not overwrite its
      // confirmed result, even if the response body finishes after the write.
      if (!pendingControlRef.current && revision === controlRevision.current) apply(data)
    }
    await Promise.allSettled([
      fetchInto('device', '设备信息', () => api.getDeviceInfo(), applyControl(setDeviceInfo)),
      fetchInto('network', '网络信息', () => api.getNetworkInfo(), applyControl((network) => setNetworkInfo((previous) => mergeNetworkInfo(previous, network)))),
      pendingControlRef.current ? Promise.resolve() : fetchInto('airplane', '飞行模式状态', () => api.getAirplaneMode(), applyControl(setAirplaneMode)),
      fetchInto('ims', 'IMS 状态', () => api.getImsStatus(), applyControl(setImsStatus)),
      pendingControlRef.current ? Promise.resolve() : fetchInto('roaming', '漫游状态', () => api.getRoamingStatus(), applyControl(setRoaming)),
      // The layout owns this shared state. Only the five header property reads
      // continue on other routes; dashboard diagnostics retain their old scope.
      ...(dashboardActive ? [
        fetchInto('sim', 'SIM 信息', () => api.getSimInfo(), setSimInfo),
        fetchInto('stats', '系统状态', () => api.getSystemStats(), (stats) => {
          setSystemStats(stats)
          updateSpeedHistory(stats)
        }),
        pendingControlRef.current ? Promise.resolve() : fetchInto('data', '数据连接状态', () => api.getDataStatus(), applyControl((status) => setDataStatus(status.active))),
        fetchInto('cells', '小区信息', () => api.getCellsInfo(), applyControl(setCellsInfo)),
        fetchInto('qos', 'QoS 信息', () => api.getQosInfo(), setQosInfo, () => setQosInfo(null)),
      ] : []),
    ])
  }, [dashboardActive, fetchInto, updateSpeedHistory])

  const loadConnectivity = useCallback(async () => {
    await fetchInto('connectivity', '连通性检测', () => api.getConnectivity(), setConnectivity)
  }, [fetchInto])

  const changeControl = useCallback(async <T,>(
    control: PendingControl['control'],
    target: boolean,
    request: () => Promise<ApiResponse<T>>,
    apply: (data: T) => void,
    read: () => Promise<ApiResponse<T>>,
    matches: (data: T) => boolean,
  ) => {
    if (pendingControlRef.current) return
    const pending = { control, target }
    pendingControlRef.current = pending
    controlRevision.current++
    setPendingControl(pending)
    setError(null)
    const deadline = Date.now() + 60_000
    const verify = async () => {
      const confirmed = await readDeferredControl(read, matches, Math.max(0, deadline - Date.now()))
      if (confirmed !== undefined) apply(confirmed)
    }
    try {
      const response = await request()
      if (isDeferredResponse(response)) { await verify(); return }
      if (response.status !== 'ok' || response.data === undefined || response.data === null) {
        throw new Error(response.message || '设备未确认操作结果，请重试')
      }
      apply(response.data)
    } catch (err) {
      if (isDeferredMessage(String(err))) {
        try { await verify() } catch (reason) {
          if (!isDeferredMessage(String(reason))) setError(reason instanceof Error ? reason.message : String(reason))
        }
      } else setError(err instanceof Error ? err.message : String(err))
    } finally {
      controlRevision.current++
      pendingControlRef.current = null
      setPendingControl(null)
    }
  }, [setError])

  const toggleData = useCallback(async (target = !dataStatus) => {
    if (dataStatus === null) return
    if (dataStatus === target) return
    await changeControl('data', target, () => api.setDataStatus(target), (status) => setDataStatus(status.active),
      () => api.getDataStatus(), (status) => status.active === target)
  }, [dataStatus, changeControl])

  const toggleAirplaneMode = useCallback(async (target = !airplaneMode?.enabled) => {
    if (!airplaneMode) return
    if (airplaneMode.enabled === target) return
    await changeControl('airplane', target, () => api.setAirplaneMode(target), (status) => {
      if (status.enabled !== target || status.online !== !target) {
        throw new Error('设备尚未确认飞行模式切换，请稍后检查状态')
      }
      setAirplaneMode(status)
      if (typeof status.data_active === 'boolean') setDataStatus(status.data_active)
    }, () => api.getAirplaneMode(), (status) => status.enabled === target && status.online === !target)
  }, [airplaneMode, changeControl])

  const toggleRoaming = useCallback(async (target = !roaming?.roaming_allowed) => {
    if (!roaming) return
    if (roaming.roaming_allowed === target) return
    await changeControl('roaming', target, () => api.setRoamingAllowed(target), setRoaming,
      () => api.getRoamingStatus(), (status) => status.roaming_allowed === target)
  }, [roaming, changeControl])

  useAdaptivePolling({
    refreshInterval,
    // Entering the dashboard loads its extra sections immediately. Moving
    // between other routes keeps the shared header polling cycle intact.
    refreshKey: refreshKey * 2 + Number(dashboardActive),
    onTick: loadData,
  })

  useAdaptivePolling({
    refreshInterval: dashboardActive ? connectivityRefreshInterval : 0,
    refreshKey,
    immediate: dashboardActive,
    onTick: loadConnectivity,
  })

  return {
    initialLoading,
    error,
    setError,
    waitingMessage,
    pendingControl,
    data: {
      deviceInfo,
      simInfo,
      systemStats,
      networkInfo,
      dataStatus,
      cellsInfo,
      cellsStale: !!waiting.cells || airplaneMode?.enabled === true || !['registered', 'roaming'].includes(networkInfo?.registration_status ?? ''),
      qosInfo: airplaneMode?.enabled || !['registered', 'roaming'].includes(networkInfo?.registration_status ?? '') ? null : qosInfo,
      airplaneMode,
      imsStatus,
      connectivity,
      speedHistory,
      roaming,
    } as DashboardData,
    actions: {
      toggleData,
      toggleAirplaneMode,
      toggleRoaming,
      loadData,
    } as DashboardActions,
  }
}
