export const NACOS_CONFIG_TYPES = Object.freeze([
  {type:'yaml',label:'YAML'}, {type:'json',label:'JSON'}, {type:'properties',label:'Properties'},
  {type:'xml',label:'XML'}, {type:'html',label:'HTML'}, {type:'text',label:'Text'},
])
export const nacosConfigTypeValues = NACOS_CONFIG_TYPES.map(item=>item.type)
export function normalizeNacosConfigType(type) {
  if(typeof type!=='string')return 'text'
  const value=type.trim().toLowerCase()
  return value==='yml'?'yaml':nacosConfigTypeValues.includes(value)?value:type.trim() || 'text'
}
export function isSupportedNacosConfigType(type) {return nacosConfigTypeValues.includes(normalizeNacosConfigType(type))}
export function resolveNacosConfigType(type,dataId='') {
  if(typeof type==='string'&&type.trim())return normalizeNacosConfigType(type)
  const suffix=normalizeNacosConfigType(dataId.split('.').at(-1))
  return isSupportedNacosConfigType(suffix)?suffix:'text'
}
export function nacosConfigValidationNote(type) {
  const normalized=normalizeNacosConfigType(type)
  return normalized==='text'?'纯文本不进行格式校验':!isSupportedNacosConfigType(normalized)?'此配置类型未校验，按原类型保存':''
}
