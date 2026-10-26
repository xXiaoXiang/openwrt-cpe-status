import { createContext, useContext } from 'react'

export const DashboardHeaderContext = createContext<{
  target: HTMLDivElement | null
  setTarget: (element: HTMLDivElement | null) => void
}>({ target: null, setTarget: () => {} })

export const useDashboardHeader = () => useContext(DashboardHeaderContext)
