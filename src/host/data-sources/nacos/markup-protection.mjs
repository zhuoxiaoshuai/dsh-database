import {inspectNacosXml,parseNacosHtml,decodeXmlText} from '../../../shared/nacos-markup.mjs'

const ambiguous=()=>{throw new Error('无法安全定位标记配置。')}
const template=/\{\{|\{%|\$\{|<%/
const indirect=/^(?:name|key|id|property)$/i
const secretAssignment=/(?:password|passwd|pwd|secret|token|credential|authorization|private.?key|api.?key|access.?key)["']?\s*[:=]/i
const htmlVoid=new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
const htmlOptional=new Set('html head body li dt dd p rt rp optgroup option colgroup thead tbody tfoot tr td th'.split(' '))

/** Returns protected raw source ranges; parsed/decoded values are used only for detection. */
export function protectMarkup(text,type,add,sensitive,credential) {
  const isSecret=value=>sensitive.test(value)||credential.test(value)
  if(type==='xml') {
    const {tree,issues,hasDoctype}=inspectNacosXml(text)
    if(issues.length||hasDoctype)ambiguous()
    tree.iterate({enter(ref){
      const node=ref.node
      if(node.type.isError)ambiguous()
      if(node.name==='Element') {
        const tag=node.getChild('OpenTag') || node.getChild('SelfClosingTag')
        if(!tag)ambiguous()
        const nameNode=tag.getChild('TagName'),name=text.slice(nameNode.from,nameNode.to)
        const attrs=tag.getChildren('Attribute').map(attr=>{
          const key=attr.getChild('AttributeName'),value=attr.getChild('AttributeValue')
          if(!key||!value)ambiguous()
          return {name:text.slice(key.from,key.to),value:decodeXmlText(text.slice(value.from+1,value.to-1))}
        })
        if(sensitive.test(name)||attrs.some(attr=>sensitive.test(attr.name)||credential.test(attr.value)||secretAssignment.test(attr.value)||indirect.test(attr.name)&&sensitive.test(attr.value)||template.test(attr.value))){add(node.from,node.to);return false}
        let direct=''
        for(let child=node.firstChild;child;child=child.nextSibling) {
          if(['Text','EntityReference','CharacterReference'].includes(child.name))direct+=decodeXmlText(text.slice(child.from,child.to))
          if(child.name==='Cdata')direct+=text.slice(child.from+9,child.to-3)
        }
        if(credential.test(direct)||secretAssignment.test(direct)||template.test(direct)){add(node.from,node.to);return false}
      }
      if(node.name==='Comment'&&isSecret(text.slice(node.from,node.to)))add(node.from,node.to)
      if(node.name==='ProcessingInst'&&(!/^<\?xml\s/i.test(text.slice(node.from,node.to))||isSecret(text.slice(node.from,node.to))))add(node.from,node.to)
    }})
    return
  }
  const {root,errors}=parseNacosHtml(text)
  if(errors.length)ambiguous()
  const coverage=[]
  const record=loc=>{if(loc)coverage.push({start:loc.startOffset,end:loc.endOffset})}
  const walk=(node,depth=0)=>{
    if(depth>256)ambiguous()
    const loc=node.sourceCodeLocation
    if(node.tagName){
      const name=node.tagName
      if(!loc){if(!['html','head','body','tbody'].includes(name))ambiguous()}
      else {
        if(!loc.startTag || text.slice(loc.startTag.startOffset,loc.startTag.endOffset).toLowerCase().indexOf('<'+name)!==0)ambiguous()
        if(!loc.endTag&&!htmlVoid.has(name)&&!htmlOptional.has(name))ambiguous()
        record(loc.startTag);record(loc.endTag)
        const attrs=node.attrs || []
        if(sensitive.test(name)||['script','style','template'].includes(name)||attrs.some(attr=>sensitive.test(attr.name)||credential.test(attr.value)||secretAssignment.test(attr.value)||indirect.test(attr.name)&&sensitive.test(attr.value)||/^on/i.test(attr.name)||['style','srcdoc'].includes(attr.name)||/^\s*(?:javascript|vbscript|data):/i.test(attr.value)||template.test(attr.value)))add(loc.startOffset,loc.endOffset)
        const direct=(node.childNodes||[]).filter(child=>child.nodeName==='#text').map(child=>child.value).join('')
        if(credential.test(direct)||secretAssignment.test(direct)||template.test(direct))add(loc.startOffset,loc.endOffset)
      }
    } else if(node.nodeName==='#text'||node.nodeName==='#comment'||node.nodeName==='#documentType') {
      if(!loc)ambiguous()
      record(loc)
      const value=node.value || node.data || ''
      if((node.nodeName==='#comment'&&isSecret(value))||(node.nodeName==='#documentType'&&isSecret(text.slice(loc.startOffset,loc.endOffset)))||credential.test(value)||template.test(value)||secretAssignment.test(value))add(loc.startOffset,loc.endOffset)
    }
    const children=node.childNodes||[]
    let last=-1
    for(const child of children){
      const childLoc=child.sourceCodeLocation
      if(childLoc){
        if(childLoc.startOffset<last)ambiguous()
        last=childLoc.endOffset
        if(loc?.startTag && (childLoc.startOffset<loc.startTag.endOffset || childLoc.endOffset>(loc.endTag?.startOffset??loc.endOffset)))ambiguous()
      }
      walk(child,depth+1)
    }
    if(node.content)walk(node.content,depth+1)
  }
  walk(root)
  // Repaired/discarded source tokens cannot be safely mapped back for exact edits.
  coverage.sort((a,b)=>a.start-b.start)
  let end=0
  for(const range of coverage){if(range.start>end&&text.slice(end,range.start).trim())ambiguous();end=Math.max(end,range.end)}
  if(text.slice(end).trim())ambiguous()
}
