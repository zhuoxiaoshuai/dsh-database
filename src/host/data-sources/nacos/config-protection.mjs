import { parseDocument, isMap, isSeq, isScalar } from 'yaml'
import { parseTree } from 'jsonc-parser'
const sensitive = /(?:password|passwd|pwd|secret|token|credential|authorization|private.?key|signing.?key|encryption.?key|access.?key|api.?key)/i
const credential = /-----BEGIN [^-]*PRIVATE KEY-----|(?:[a-z][a-z0-9+.-]*:\/\/|jdbc:)[^\s]*:[^\s@]+@|(?:AKIA|ASIA)[A-Z0-9]{16}|\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.~-]{6,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i
const invalid = () => { throw new Error('无法安全解析配置或修改敏感字段，请使用人工编辑。') }

export function protectedConfig(text, type) {
  const ranges = []
  const add = (start, end) => ranges.push({start, end})
  try {
    if (type === 'json') {
      const errors = [], root = parseTree(text, errors, {allowTrailingComma: false, disallowComments: true})
      if (!root || errors.length) return {safe: false, ranges: [], text: '[配置无法安全解析]'}
      const walk = node => {
        if (node.type === 'object') {const keys = node.children.map(child => child.children?.[0]?.value); if (new Set(keys).size !== keys.length) invalid()}
        if (node.type === 'property' && (sensitive.test(String(node.children?.[0]?.value)) || credential.test(String(node.children?.[1]?.value))
          || (node.children?.[1]?.type === 'array' && credential.test(text.slice(node.offset,node.offset+node.length))))) add(node.offset, node.offset + node.length)
        else for (const child of node.children || []) walk(child)
      }; walk(root)
    } else if (type === 'yaml' || type === 'yml') {
      const doc = parseDocument(text, {uniqueKeys: true, keepSourceTokens: true})
      if (doc.errors.length) return {safe: false, ranges: [], text: '[配置无法安全解析]'}
      const walk = node => {
        if (!node) return
        if (node.anchor || node.tag || node.constructor?.name === 'Alias') invalid()
        if (isMap(node)) for (const pair of node.items) {
          if (!isScalar(pair.key) || pair.key.anchor || pair.key.tag) invalid()
          if (sensitive.test(String(pair.key.value)) || (isScalar(pair.value) && credential.test(String(pair.value.value)))
            || (isSeq(pair.value) && credential.test(text.slice(pair.value.range[0],pair.value.range[2])))) {
            if (!pair.key.range || !pair.value?.range) invalid()
            add(pair.key.range[0], pair.value.range[2])
          } else walk(pair.value)
        } else if (isSeq(node)) node.items.forEach(walk)
      }; walk(doc.contents)
    } else if (type === 'properties') {
      let offset = 0; const keys=new Set()
      for (const line of text.split(/(?<=\n)/)) {
        // Continuations and escaped names require Java Properties decoding; fail closed.
        if (/\\/.test(line)) invalid()
        const match = line.match(/^\s*([^#!\s:=]+)\s*(?:[:=]|\s)\s*/)
        if (line.trim() && !/^\s*[#!]/.test(line) && !match) invalid()
        if (match) {if(keys.has(match[1])) invalid();keys.add(match[1])}
        if (match && (sensitive.test(match[1]) || credential.test(line))) add(offset, offset + line.replace(/\r?\n$/, '').length)
        offset += line.length
      }
    } else return {safe: false, ranges: [], text: '[此配置格式不向 AI 返回正文]'}
    // Comments can contain credentials even when they are not parsed as fields.
    for (const match of text.matchAll(/^.*(?:password|secret|token|private.?key|credential)\s*[:=].*$/gmi)) {
      if (!ranges.some(r => match.index >= r.start && match.index < r.end)) add(match.index, match.index + match[0].length)
    }
    for(const match of text.matchAll(/^.*$/gm)) if(credential.test(match[0]) && /^\s*[#!\/]/.test(match[0])
      && !ranges.some(r=>match.index>=r.start&&match.index<r.end)) add(match.index,match.index+match[0].length)
    // A credential outside a reliably parsed field or comment is not editable/model-visible.
    for(const match of text.matchAll(new RegExp(credential.source,'gi'))) if(!ranges.some(r=>match.index>=r.start&&match.index+match[0].length<=r.end)) invalid()
    ranges.sort((a,b) => a.start - b.start)
    let masked = text
    for (const range of [...ranges].reverse()) masked = masked.slice(0, range.start) + '[REDACTED]' + masked.slice(range.end)
    return {safe: true, ranges, text: masked}
  } catch { return {safe: false, ranges: [], text: '[配置无法安全解析]'} }
}
export function applyPublicEdits(text, type, edits) {
  const protection = protectedConfig(text, type)
  if (!protection.safe || !Array.isArray(edits) || !edits.length || edits.length > 50) invalid()
  const replacements = edits.map(edit => {
    if (typeof edit?.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' || edit.newText.includes('[REDACTED]')) invalid()
    const start = text.indexOf(edit.oldText), end = start + edit.oldText.length
    if (start < 0 || text.indexOf(edit.oldText, start + 1) !== -1 || protection.ranges.some(r => start < r.end && end > r.start)) invalid()
    return {start, end, text: edit.newText}
  }).sort((a,b) => a.start - b.start)
  if (replacements.some((r,i) => i && r.start < replacements[i-1].end)) invalid()
  let next = text
  for (const r of [...replacements].reverse()) next = next.slice(0,r.start) + r.text + next.slice(r.end)
  const after = protectedConfig(next, type)
  if (!after.safe || after.ranges.length !== protection.ranges.length) invalid()
  const originalSecrets = protection.ranges.map(r => text.slice(r.start,r.end))
  if (after.ranges.some((r,i) => next.slice(r.start,r.end) !== originalSecrets[i])) invalid()
  return next
}
export function aiProjection(value) {
  if (Array.isArray(value)) return value.map(aiProjection)
  if (!value || typeof value !== 'object') return typeof value === 'string' && (credential.test(value) || /(?:password|passwd|secret|token|credential|private.?key|api.?key|access.?key)["']?\s*[:=]/i.test(value)) ? '[REDACTED]' : value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (sensitive.test(key)) { out[key] = '[REDACTED]'; continue }
    if (key === 'content' && typeof item === 'string') out[key] = value.encrypted ? '[加密配置不向 AI 返回]' : protectedConfig(item, value.type).text
    else out[key] = aiProjection(item)
  }
  return out
}
