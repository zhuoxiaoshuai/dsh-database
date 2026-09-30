export type RequestTicket = { readonly identity: string; readonly epoch: number; readonly signal: AbortSignal }

/** Invalidates all outstanding client work when a connection generation or component changes. */
export function createRequestScope(identity: string) {
  let currentIdentity = identity
  let epoch = 0
  let disposed = false
  const controllers = new Set<AbortController>()
  return {
    begin(): RequestTicket {
      const controller = new AbortController()
      if (disposed) controller.abort()
      else controllers.add(controller)
      return { identity: currentIdentity, epoch, signal: controller.signal }
    },
    isCurrent(ticket: RequestTicket): boolean {
      return !disposed && ticket.identity === currentIdentity && ticket.epoch === epoch && !ticket.signal.aborted
    },
    finish(ticket: RequestTicket): void {
      for (const controller of controllers) if (controller.signal === ticket.signal) { controllers.delete(controller); break }
    },
    cancel(ticket: RequestTicket): void {
      for (const controller of controllers) if (controller.signal === ticket.signal) { controller.abort(); controllers.delete(controller); break }
    },
    invalidate(nextIdentity: string): void {
      for (const controller of controllers) controller.abort()
      controllers.clear()
      currentIdentity = nextIdentity
      epoch += 1
    },
    dispose(): void {
      this.invalidate(currentIdentity)
      disposed = true
    },
  }
}
