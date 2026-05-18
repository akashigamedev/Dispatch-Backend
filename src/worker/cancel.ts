const cancelRequests = new Set<number>()
let currentTaskId: number | null = null

export function requestCancel(taskId: number): void {
  cancelRequests.add(taskId)
}

export function isCancelRequested(taskId: number): boolean {
  return cancelRequests.has(taskId)
}

export function clearCancel(taskId: number): void {
  cancelRequests.delete(taskId)
}

export function setCurrentTask(id: number | null): void {
  currentTaskId = id
}

export function getCurrentTask(): number | null {
  return currentTaskId
}

export class CancelError extends Error {
  constructor() {
    super('task cancelled by user')
    this.name = 'CancelError'
  }
}
