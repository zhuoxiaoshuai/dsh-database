import {XMLValidator} from 'fast-xml-parser'
import {parser as xmlParser} from '@lezer/xml'
import {parse,parseFragment} from 'parse5'

export function sourceOffset(text,line,column) {
  let start=0,current=1
  for(const match of text.matchAll(/\r\n|\r|\n/g)) {if(current++===line)break;start=match.index+match[0].length}
  return Math.min(text.length,start+Math.max(0,column-1))
}
export function decodeXmlText(text) {
  return text.replace(/&(#x[\da-fA-F]+|#\d+|[\w:.-]+);/g,(_match,key)=>{
    const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}
    if(key in named)return named[key]
    if(key[0]==='#'){
      const code=key[1]==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10)
      if(code===9||code===10||code===13||code>=32&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)&&code!==0xfffe&&code!==0xffff)return String.fromCodePoint(code)
    }
    throw new Error('无法安全解析 XML 实体。')
  })
}
export function parseNacosHtml(text) {
  const errors=[]
  const document=/^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\b|<(?:html|head|body)\b)/i.test(text)
  const options={sourceCodeLocationInfo:true,scriptingEnabled:false,onParseError:error=>{if(error.code!=='missing-doctype'&&errors.length<100)errors.push(error)}}
  return {root:document?parse(text,options):parseFragment(text,options),errors}
}

/** XMLValidator is supplemented with source-tree checks for multiple roots and entities. */
export function inspectNacosXml(text) {
  const tree=xmlParser.parse(text),issues=[]
  const add=(code,reason,from,to=from+1)=>{if(issues.length<100)issues.push({code,reason,from,to})}
  const validation=XMLValidator.validate(text,{allowBooleanAttributes:false})
  if(validation!==true){const from=sourceOffset(text,validation.err.line,validation.err.col);add(validation.err.code,validation.err.code==='InvalidAttr'?'属性格式无效或属性重复':'XML 标签、引号或文档结构无效',from)}
  const roots=[];let hasDoctype=false
  const declared=new Set(['amp','lt','gt','quot','apos'])
  // Declarations are recognized but never fetched or expanded.
  for(let node=tree.topNode.firstChild;node;node=node.nextSibling){if(node.name==='Element')roots.push(node);if(node.name==='DoctypeDecl')hasDoctype=true}
  if(hasDoctype)for(const match of text.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<!ENTITY\s+(?!%)\s*([\w:.-]+)\s/g))declared.add(match[1])
  if(roots.length!==1)add('XML_ROOT','XML 配置需要且只能有一个根元素',roots[1]?.from ?? 0)
  const namespaces=[new Map([['xml','http://www.w3.org/XML/1998/namespace']])]
  tree.iterate({enter(node){
    if(node.name==='Element'){
      const inherited=new Map(namespaces.at(-1)),tag=node.node.getChild('OpenTag')||node.node.getChild('SelfClosingTag')
      namespaces.push(inherited)
      if(tag){
        const attrs=tag.getChildren('Attribute').map(attr=>({node:attr,key:attr.getChild('AttributeName'),value:attr.getChild('AttributeValue')}))
        for(const attr of attrs)if(attr.key&&attr.value){
          const key=text.slice(attr.key.from,attr.key.to)
          if(key==='xmlns'||key.startsWith('xmlns:')){
            const prefix=key==='xmlns'?'':key.slice(6)
            try{
              const uri=decodeXmlText(text.slice(attr.value.from+1,attr.value.to-1))
              if(prefix==='xmlns'||(prefix==='xml')!==(uri==='http://www.w3.org/XML/1998/namespace')||uri==='http://www.w3.org/2000/xmlns/'||prefix&& !uri)add('XML_NAMESPACE','命名空间声明无效',attr.node.from,attr.node.to)
              inherited.set(prefix,uri)
            }catch{add('XML_ENTITY','命名空间实体引用无效',attr.node.from,attr.node.to)}
          }
        }
        const expanded=new Set()
        for(const nameNode of [tag.getChild('TagName'),...attrs.map(attr=>attr.key)])if(nameNode){
          const name=text.slice(nameNode.from,nameNode.to)
          if(name==='xmlns'||name.startsWith('xmlns:'))continue
          const parts=name.split(':')
          if(parts.length>2||parts.some(part=>!part)||parts.length===2&&!inherited.get(parts[0]))add('XML_NAMESPACE','元素或属性使用了无效或未声明的命名空间',nameNode.from,nameNode.to)
          if(nameNode.name==='AttributeName'){
            const key=JSON.stringify([parts.length===2?inherited.get(parts[0]):'',parts.at(-1)])
            if(expanded.has(key))add('XML_ATTRIBUTE','同一元素内命名空间属性重复',nameNode.from,nameNode.to)
            expanded.add(key)
          }
        }
      }
    }
    if(node.type.isError&&!hasDoctype)add('XML_SYNTAX','XML 标签、引号或文档结构无效',node.from,node.to)
    if(node.name==='EntityReference'){
      const name=text.slice(node.from+1,node.to-1)
      if(!declared.has(name))add('XML_ENTITY','引用了未声明的 XML 实体',node.from,node.to)
    }
    if(node.name==='CharacterReference')try{decodeXmlText(text.slice(node.from,node.to))}catch{add('XML_ENTITY','XML 字符引用无效',node.from,node.to)}
  },leave(node){if(node.name==='Element')namespaces.pop()}})
  return {tree,issues,hasDoctype}
}
