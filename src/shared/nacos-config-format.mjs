import {parseTree, printParseErrorCode} from 'jsonc-parser'
import {isMap, parseAllDocuments} from 'yaml'
import {normalizeNacosConfigType} from './nacos-config-types.mjs'
import {inspectNacosXml,parseNacosHtml} from './nacos-markup.mjs'

const jsonReasons = {
  InvalidSymbol: '存在非法字符', InvalidNumberFormat: '数字格式无效', PropertyNameExpected: '需要带双引号的字段名',
  ValueExpected: '缺少有效的值', ColonExpected: '字段名后缺少冒号', CommaExpected: '字段之间缺少逗号',
  CloseBraceExpected: '缺少右花括号 }', CloseBracketExpected: '缺少右方括号 ]', EndOfFileExpected: '正文末尾有多余内容',
  InvalidCommentToken: 'JSON 不允许注释', UnexpectedEndOfComment: '注释未结束，JSON 不允许注释',
  UnexpectedEndOfString: '字符串缺少结束引号', UnexpectedEndOfNumber: '数字不完整',
  InvalidUnicode: 'Unicode 转义无效', InvalidEscapeCharacter: '转义字符无效', InvalidCharacter: '字符串包含非法字符',
}
const yamlReasons = {
  DUPLICATE_KEY: '同一对象内字段名重复', BAD_INDENT: '缩进不符合 YAML 语法', TAB_AS_INDENT: '缩进不能使用 Tab，请使用空格',
  MISSING_CHAR: '缺少必要的括号、引号或分隔符', BAD_DQ_ESCAPE: '双引号字符串中的转义无效',
  MULTILINE_IMPLICIT_KEY: '键名不能这样跨行，请检查冒号和缩进', BLOCK_AS_IMPLICIT_KEY: '键名结构无效，请检查缩进',
  UNEXPECTED_TOKEN: '存在意外符号，请检查括号、引号和缩进', MISSING_VALUE: '缺少必要的值',
}

/** Safe diagnostics shared by UI and Host. Never include parser messages or source excerpts. */
export function diagnoseNacosConfigFormat(content, type) {
  const issues = []
  if (typeof content !== 'string' || typeof type !== 'string') return [{from:0,to:0,line:1,column:1,code:'INVALID_INPUT',message:'配置正文或类型无效。'}]
  const add = (format, code, reason, offset = 0, length = 1) => {
    // Bound rendering, while retaining at least one blocking issue for invalid documents.
    if (issues.length >= 100) return
    const from = Math.max(0, Math.min(content.length, offset)), to = Math.min(content.length, from + Math.max(1, length))
    const lines = content.slice(0, from).split(/\r\n|\r|\n/)
    issues.push({from,to,line:lines.length,column:lines.at(-1).length+1,code,message:`${format} 格式错误：${reason}`})
  }
  const format = normalizeNacosConfigType(type)
  if (format === 'json') {
    const errors = [], root = parseTree(content, errors, {allowTrailingComma:false,disallowComments:true})
    for (const error of errors) {
      const code = printParseErrorCode(error.error)
      add('JSON', code, jsonReasons[code] || '语法无效', error.offset, error.length)
    }
    if (!root && !errors.length) add('JSON','EMPTY','正文不能为空')
    const walk = node => {
      if (node.type === 'object') {
        const keys = new Set()
        for (const property of node.children || []) {
          const key = property.children?.[0]
          if (key && keys.has(key.value)) add('JSON','DUPLICATE_KEY','同一对象内字段名重复',key.offset,key.length)
          if (key) keys.add(key.value)
        }
      }
      for (const child of node.children || []) walk(child)
    }
    if (root) walk(root)
  } else if (format === 'yaml') {
    const docs = parseAllDocuments(content, {uniqueKeys:true,prettyErrors:false})
    if (!docs.length) add('YAML','CONFIG_ROOT','配置需要顶层键值对象，不能是空内容或纯文本')
    for (const doc of docs) {
      for (const error of doc.errors) add('YAML',error.code,yamlReasons[error.code] || '语法无效，请检查结构和缩进',error.pos?.[0],(error.pos?.[1] || 0)-(error.pos?.[0] || 0))
      if (!doc.errors.length && !isMap(doc.contents)) add('YAML','CONFIG_ROOT','配置需要顶层键值对象，不能是纯文本、列表或单个值',doc.contents?.range?.[0] ?? doc.range?.[0] ?? 0)
    }
  } else if (format === 'properties') {
    // Preserve Java Properties semantics; keep a source map across logical-line continuations.
    let logical = '', positions = [], offset = 0, continuing = false
    const checkLogical=()=>{
      for (let i=0;i<logical.length;i++) if (logical[i] === '\\') {
        if (logical[++i] === 'u') {
          if (!/^[\da-fA-F]{4}/.test(logical.slice(i+1))) add('Properties','INVALID_UNICODE','Unicode 转义需要 4 位十六进制数字',positions[i-1],2)
          i += 4
        }
      }
      logical='';positions=[]
    }
    for (const line of content.split(/(?<=\n)|(?<=\r)(?!\n)/)) {
      const raw = line.replace(/(?:\r\n|\r|\n)$/, '')
      if (!continuing && /^[ \t\f]*[#!]/.test(raw)) {offset += line.length;continue}
      const skip = continuing ? raw.match(/^[ \t\f]*/)[0].length : 0
      logical += raw.slice(skip)
      for (let i=skip;i<raw.length;i++) positions.push(offset+i)
      offset += line.length
      continuing = (raw.match(/\\+$/)?.[0].length || 0) % 2 === 1 && /[\r\n]$/.test(line)
      if (continuing) {logical=logical.slice(0,-1);positions.pop();continue}
      checkLogical()
    }
    if(logical)checkLogical()
  } else if(format==='xml') {
    for(const issue of inspectNacosXml(content).issues)add('XML',issue.code,issue.reason,issue.from,issue.to-issue.from)
  } else if(format==='html') {
    for(const issue of parseNacosHtml(content).errors) {
      const reasons={'duplicate-attribute':'属性重复','eof-in-tag':'标签或属性引号未结束','eof-in-comment':'注释未结束','unexpected-null-character':'存在非法空字符','unknown-named-character-reference':'字符实体未定义','missing-semicolon-after-character-reference':'字符实体缺少分号'}
      add('HTML',issue.code,reasons[issue.code] || 'HTML 标签、属性或字符引用格式无效',issue.startOffset,issue.endOffset-issue.startOffset)
    }
  }
  return issues.sort((a,b)=>a.from-b.from)
}

export function validateNacosConfigFormat(content, type) {
  const issues = diagnoseNacosConfigFormat(content,type)
  if (issues.length) {
    const first=issues[0]
    throw Object.assign(new Error(`${first.message}（第 ${first.line} 行，第 ${first.column} 列）。`),{issues})
  }
}
