import { registerAiTools } from '../ai-tools.ts'

/** MySQL and Oracle share one existing SQL tool group. */
export const sqlAi = Object.freeze({ key: 'sql', register: registerAiTools })
