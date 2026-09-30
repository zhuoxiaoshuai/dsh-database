import React from 'react'
export const mockClientModule = {
  id: 'mock-source', descriptor: { id: 'mock-source', displayName: '模拟源', family: 'kafka', showsSchemaTree: false },
  logo: { viewBox: '0 0 1 1', artwork: null },
  connection: { id: 'mock-source', createInput: () => ({}), showCredentials: () => false, fields: () => null },
  workspace: { mode: 'standard', useBindings({ host, connection }) {
    return { sourceName: '模拟源', initialQuery: 'READ item',
      overview: onUse => <button type="button" onClick={() => onUse('READ item')}>查询对象 item</button>,
      Editor: ({ value, onChange, onRun }) => <textarea aria-label="模拟源操作" value={value} onChange={e => onChange(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(value) } }} />,
      Result: ({ result }) => result ? <p>{result.value}</p> : null,
      runText: (text, signal) => host.executeText(connection, text, {}, signal),
    }
  } },
  history: { id: 'mock-source', renderText: record => record.title, resultEnvelope: (_record, payload) => ({ sourceId: 'mock-source', kind: 'mock', status: 'succeeded', truncated: false, payload }), renderResult: envelope => <p>{envelope.payload?.value}</p> },
}
