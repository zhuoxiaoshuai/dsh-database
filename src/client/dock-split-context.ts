import { createContext, useContext } from 'react'

export type DockSplitApi = {
  beginSteal(): void
  stealEditor(pixels: number): number
}

const idle: DockSplitApi = { beginSteal() {}, stealEditor: () => 0 }

export const DockSplitContext = createContext<DockSplitApi>(idle)

export function useDockSplit(): DockSplitApi {
  return useContext(DockSplitContext)
}
