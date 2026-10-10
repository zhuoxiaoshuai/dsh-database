export const nacosRuntime = Object.freeze({
  id: 'nacos', workerEntry: 'nacos-worker.mjs', requiresPassword: false, usesCustomCa: () => false,
  actions: Object.freeze(['nacos-health', 'nacos-namespaces', 'nacos-configs', 'nacos-config', 'nacos-history', 'nacos-listeners', 'nacos-services', 'nacos-service', 'nacos-instances', 'nacos-write']),
})
