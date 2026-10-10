const HOST = /^(?:[a-zA-Z0-9._:\-]+|\[[0-9a-fA-F:.]+\])$/
export function nacosEndpoint(input) {
  const host = String(input.host || '').trim(), port = Number(input.port)
  const protocol = input.protocol ?? 'http'
  const contextPath = input.contextPath ?? '/nacos'
  if (!HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !['http', 'https'].includes(protocol)) throw new Error('请填写有效的主机、端口和协议。')
  if (typeof contextPath !== 'string' || contextPath.length > 256 || (contextPath && !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(contextPath))) throw new Error('Nacos 路径无效。')
  const endpoint = `${protocol}://${host}:${port}${contextPath.replace(/\/$/, '')}`
  try {new URL(endpoint)} catch {throw new Error('请填写有效的主机；IPv6 地址需使用方括号。')}
  return endpoint
}
