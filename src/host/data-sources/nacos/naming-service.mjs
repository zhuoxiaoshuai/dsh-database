import { scope, paging } from './configuration-service.mjs'
import { NacosError } from './http-client.mjs'
export class NamingService {
  constructor(client) { this.client = client }
  async read(action, input, signal) {
    const target = scope(input), namespaceId = target.namespaceId || 'public'
    if (action === 'nacos-services') {
      const data = await this.client.request('/v1/ns/catalog/services', {query: {namespaceId, ...paging(input), serviceNameParam: input.serviceName || '', groupNameParam: input.group || '', withInstances: false}, signal})
      return {items: data.serviceList || data.list || [], total: data.count ?? data.totalCount}
    }
    if (!input.group || !input.serviceName) throw new NacosError('invalid', '请明确提供 Group 和服务名。')
    const serviceName = `${input.group}@@${input.serviceName}`
    if (action === 'nacos-service') {
      const service = await this.client.request('/v1/ns/catalog/service', {query: {namespaceId, serviceName}, signal})
      if (!input.includeInstances) return service
      const clusterName = input.clusterName || service.clusters?.[0]?.name || 'DEFAULT'
      const instances = await this.client.request('/v1/ns/catalog/instances', {query: {namespaceId, serviceName, clusterName, ...paging(input)}, signal})
      return {...service, clusterName, instances}
    }
    if (action === 'nacos-instances') return this.client.request('/v1/ns/catalog/instances', {query: {namespaceId, serviceName, clusterName: input.clusterName || 'DEFAULT', ...paging(input)}, signal})
    throw new NacosError('unsupported', '不支持此 Nacos 服务读取操作。')
  }
}
