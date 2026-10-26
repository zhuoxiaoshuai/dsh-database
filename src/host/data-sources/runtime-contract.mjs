// runtime 形状校验的单一实现，供 modules.ts 的 createRuntimeRegistry 与 provider-registry.mjs 的
// createDataSourceRegistry 共用。必须放在 .mjs：构建把 src/host/data-sources 下的 .mjs 原样复制进
// lib/data-sources，TS 则被打包进 lib/index.js，被复制树里的注册表在运行时无法 import TS
//（两套注册层的构建边界见 docs/cleanup-facades.md）。
const DOCUMENT_KINDS = ['sql', 'command']

export function isValidSourceRuntime(runtime, { requireDocumentKind = false } = {}) {
  if (!runtime || typeof runtime.id !== 'string' || !runtime.id) return false
  if (typeof runtime.workerEntry !== 'string' || !/^[a-z][a-z0-9-]*-worker\.mjs$/.test(runtime.workerEntry)) return false
  if (typeof runtime.requiresPassword !== 'boolean' || typeof runtime.usesCustomCa !== 'function') return false
  if (!Array.isArray(runtime.actions) || !runtime.actions.length
    || runtime.actions.some(action => typeof action !== 'string' || !action)
    || new Set(runtime.actions).size !== runtime.actions.length) return false
  return runtime.documentKind === undefined ? !requireDocumentKind : DOCUMENT_KINDS.includes(runtime.documentKind)
}
