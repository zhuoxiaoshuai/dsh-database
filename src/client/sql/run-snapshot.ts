export type SqlRunSnapshot = {
  identity: string; schema: string; seq: number; connectionId: string; generation?: string; statements: string[]
}

/** The epoch makes returning to a former target insufficient to revive an old operation. */
export function ownsSqlRun(snapshot: SqlRunSnapshot | undefined, identity: string, epoch: number, mounted: boolean): snapshot is SqlRunSnapshot {
  return mounted && !!snapshot && snapshot.identity === identity && snapshot.seq === epoch
}

export function canReplaySqlRun(snapshot: SqlRunSnapshot | undefined, identity: string, epoch: number, mounted: boolean, statements: string[]): snapshot is SqlRunSnapshot {
  return ownsSqlRun(snapshot, identity, epoch, mounted) && snapshot.statements.length === statements.length
    && snapshot.statements.every((text, index) => text === statements[index])
}
