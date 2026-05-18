const cancelRequests = new Set<number>()
const controllers = new Map<number, AbortController>()
let currentTaskId: number | null = null

export function requestCancel(taskId: number): void {
  cancelRequests.add(taskId)
  controllers.get(taskId)?.abort()
}

export function isCancelRequested(taskId: number): boolean {
  return cancelRequests.has(taskId)
}

export function clearCancel(taskId: number): void {
  cancelRequests.delete(taskId)
  controllers.delete(taskId)
}

export function setCurrentTask(id: number | null): void {
  currentTaskId = id
  if (id !== null && !controllers.has(id)) controllers.set(id, new AbortController())
}

export function getCurrentTask(): number | null {
  return currentTaskId
}

export function getAbortSignal(taskId: number): AbortSignal | undefined {
  return controllers.get(taskId)?.signal
}

export class CancelError extends Error {
  constructor() {
    super('task cancelled by user')
    this.name = 'CancelError'
  }
}
