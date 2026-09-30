import React, { useState } from 'react'
import type { KeyCard } from './key-model.ts'

export function RedisKeyCard({
  kind, card, writing, onAdd, onExists,
}: {
  kind: 'hyperloglog' | 'bloom'
  card?: KeyCard
  writing?: boolean
  onAdd(value: string): void
  onExists?(value: string): Promise<string | undefined>
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [probe, setProbe] = useState('')
  const [answer, setAnswer] = useState('')
  const add = () => { if (!value) return; onAdd(value); setValue('') }
  const exists = () => {
    if (!probe || !onExists) return
    void onExists(probe).then(result => { if (result) setAnswer(result) })
  }
  return <section className="db-redis-key-card">
    {card?.count !== undefined && <p className="db-redis-key-count">{card.count}</p>}
    {!!card?.lines.length && <dl>{card.lines.map(line => <React.Fragment key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></React.Fragment>)}</dl>}
    <div className="db-redis-key-line">
      <input aria-label={kind === 'hyperloglog' ? '追加值' : '添加值'} value={value} disabled={writing} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
      <button className="db-redis-btn db-primary" type="button" disabled={writing || !value} onClick={add}>添加</button>
    </div>
    {kind === 'bloom' && <div className="db-redis-key-line">
      <input aria-label="是否存在" value={probe} disabled={writing} onChange={event => { setProbe(event.target.value); setAnswer('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); exists() } }} />
      <button className="db-redis-btn" type="button" disabled={writing || !probe} onClick={exists}>是否存在</button>
      {answer && <span className={answer === '存在' ? 'db-success' : 'db-redis-error'}>{answer}</span>}
    </div>}
  </section>
}
