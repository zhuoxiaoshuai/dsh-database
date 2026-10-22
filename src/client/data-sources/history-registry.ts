import { sqlHistory } from './sql-history.tsx'
import { redisHistory } from '../redis/history-view.tsx'
import { kafkaHistory } from '../kafka/history-view.tsx'
import { nacosHistory } from './nacos-history.tsx'

/** Detail rendering must never import the workspace composition registry. */
export const historySources = new Map([sqlHistory('mysql'), sqlHistory('oracle'), redisHistory, kafkaHistory, nacosHistory].map(source => [source.id, source]))
