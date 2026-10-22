import {copyText} from './clipboard.ts'
import React, { useState } from 'react'

export function ResourceError({message,actions}: {message: string;actions?:React.ReactNode}) {
  const [copied, setCopied] = useState(false)
  const long = message.length > 160 || message.includes('\n')
  return <div className="db-error db-resource-error" role="alert"><span>{long ? `${message.split('\n')[0].slice(0,160)}…` : message}</span>{long && <details><summary>错误详情</summary><pre>{message}</pre><button className="db-text-button" type="button" onClick={() => { void copyText(message).then(setCopied) }}>{copied ? '已复制' : '复制错误'}</button></details>}{actions}</div>
}
