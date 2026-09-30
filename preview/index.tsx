import React from 'react'
import { createRoot } from 'react-dom/client'
import { DatabaseWorkspace } from '../src/client/workspace/shell/database-workspace.tsx'

createRoot(document.getElementById('app')!).render(<DatabaseWorkspace conversationId="local-preview" preview />)
