import {useEffect} from 'react'
type Guard = () => boolean | Promise<boolean>
const guards = new Map<object | string, Map<string, Guard>>()
export function registerNavigationGuard(owner: object | string, id: string, guard: Guard) {
  let map = guards.get(owner); if (!map) {map = new Map(); guards.set(owner,map)}
  map.set(id,guard)
  return () => {if (map!.get(id) === guard) map!.delete(id); if (!map!.size) guards.delete(owner)}
}
export async function allowNavigation(owner: object | string): Promise<boolean> {
  for (const guard of guards.get(owner)?.values() || []) if (!await guard()) return false
  return true
}
export function useNavigationGuard(owner: object | string, id: string, dirty: boolean, confirm: Guard) {
  useEffect(() => dirty ? registerNavigationGuard(owner,id,confirm) : undefined,[owner,id,dirty,confirm])
  useEffect(() => {
    if (!dirty) return
    const unload = (e: BeforeUnloadEvent) => {e.preventDefault(); e.returnValue = ''}
    window.addEventListener('beforeunload',unload); return () => window.removeEventListener('beforeunload',unload)
  },[dirty])
}
