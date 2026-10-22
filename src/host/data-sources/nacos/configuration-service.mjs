import { NacosError } from './http-client.mjs'
import {resolveNacosConfigType} from '../../../shared/nacos-config-types.mjs'
export const scope = input => {
  if (typeof input.namespaceId !== 'string') throw new NacosError('invalid', '请明确提供 Namespace ID（public 使用空字符串）。')
  for (const key of ['namespaceId','group','dataId','serviceName']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 || /[\x00-\x1f]/.test(input[key]))) throw new NacosError('invalid', 'Nacos 资源范围无效。')
  return {namespaceId: input.namespaceId === 'public' ? '' : input.namespaceId, group: input.group, dataId: input.dataId}
}
export const paging = input => {
  const pageNo = input.pageNo ?? 1, pageSize = input.pageSize ?? 50
  if (!Number.isSafeInteger(pageNo) || pageNo < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new NacosError('invalid', '分页参数无效。')
  return {pageNo, pageSize}
}
export class ConfigurationService {
  constructor(client) { this.client = client }
  async read(action, input, signal) {
    if (action === 'nacos-namespaces') return {items: await this.client.request('/v1/console/namespaces', {signal})}
    const target = scope(input), query = {tenant: target.namespaceId, group: target.group || '', dataId: target.dataId || ''}
    if (action === 'nacos-configs') {
      const searchQuery=input.exact ? query : {...query,group:query.group ? `*${query.group}*` : '',dataId:query.dataId ? `*${query.dataId}*` : ''}
      const data = await this.client.request('/v1/cs/configs', {query: {...searchQuery, ...paging(input), search: input.exact ? 'accurate' : 'blur'}, signal})
      return {items: (data.pageItems || []).map(({content, encryptedDataKey, ...item}) => item), total: data.totalCount, pageNo: data.pageNumber}
    }
    if (!target.group || !target.dataId) throw new NacosError('invalid', '请明确提供 Group 和 Data ID。')
    if (action === 'nacos-config') {
      const data = await this.client.request('/v1/cs/configs', {query: {...query, show: 'all'}, signal, allowMissing:true})
      if (!data || !data.md5 || typeof data.content !== 'string') throw new NacosError('not-found', '配置不存在或缺少完整版本信息。')
      const {encryptedDataKey, ...item} = data
      return {...item,type:resolveNacosConfigType(item.type,input.dataId), encrypted: !!encryptedDataKey}
    }
    if (action === 'nacos-history') {
      const data = await this.client.request(input.historyId ? '/v2/cs/history' : '/v2/cs/history/list', {query: {...target, ...(input.historyId ? {nid: input.historyId} : paging(input))}, signal})
      if (input.historyId) { const {encryptedDataKey, ...item} = data;return {...item,type:resolveNacosConfigType(item.type,input.dataId), encrypted: !!encryptedDataKey} }
      return {items: (data.pageItems || []).map(({content, encryptedDataKey, ...item}) => item), total: data.totalCount, pageNo: data.pageNumber}
    }
    if (action === 'nacos-listeners') return {listeners: await this.client.request('/v1/cs/configs/listener', {query, signal})}
    throw new NacosError('unsupported', '不支持此 Nacos 读取操作。')
  }
  async write(input, signal) {
    const target = scope(input)
    if (!target.group || !target.dataId) throw new NacosError('invalid', '请明确提供 Group 和 Data ID。')
    const result = await this.client.request('/v2/cs/config', input.kind === 'delete' ? {method: 'DELETE', query: target, signal}
      : {method: 'POST', body: {...target, content: input.content, type: input.type || 'text'}, headers: input.kind === 'update' ? {casMd5: input.expectedMd5} : {}, signal})
    if (result !== true) throw new NacosError('conflict', '配置变更未得到成功回执，请重新读取核对。')
    return {saved: true, kind: input.kind}
  }
}
