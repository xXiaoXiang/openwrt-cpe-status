import { createContext, useContext } from 'react'
import type { useDashboardData } from '@/pages/Dashboard/hooks/useDashboardData'

export const DashboardDataContext = createContext<ReturnType<typeof useDashboardData> | null>(null)

export function useSharedDashboardData() {
  const data = useContext(DashboardDataContext)
  if (!data) throw new Error('Dashboard data must be provided by MainLayout')
  return data
}
