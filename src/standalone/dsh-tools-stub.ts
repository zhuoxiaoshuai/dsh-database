/** Standalone bundle only. The plugin build keeps the real `@deepseek-ai/dsh-tools` import. */
export function defineTool(): never {
  throw new Error('独立工作台不注册 DSH 工具。')
}
