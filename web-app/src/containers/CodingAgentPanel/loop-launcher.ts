import { invoke } from '@tauri-apps/api/core'

export interface LoopLaunchRequest {
  project_dir: string
  prompt: string
  loop_times: number
  loop_interval_minutes: number
  max_iterations?: number | null
  created_at: string
}

export interface QueueLoopLaunchRequest {
  projectDir: string
  prompt: string
  loopTimes?: number
  loopIntervalMinutes?: number
  maxIterations?: number
}

export const LOOP_LAUNCH_EVENT = 'atomic-chat:start-loop-coding'

export function normalizeLoopLaunchRequest(value: QueueLoopLaunchRequest): QueueLoopLaunchRequest {
  return {
    projectDir: value.projectDir,
    prompt: value.prompt,
    loopTimes: value.loopTimes,
    loopIntervalMinutes: value.loopIntervalMinutes,
    maxIterations: value.maxIterations,
  }
}

export async function queueLoopLaunchRequest(value: QueueLoopLaunchRequest): Promise<LoopLaunchRequest> {
  const request = normalizeLoopLaunchRequest(value)
  return invoke<LoopLaunchRequest>('queue_loop_launch_request', {
    projectDir: request.projectDir,
    prompt: request.prompt,
    loopTimes: request.loopTimes,
    loopIntervalMinutes: request.loopIntervalMinutes,
    maxIterations: request.maxIterations,
  })
}

export async function consumeLoopLaunchRequest(): Promise<LoopLaunchRequest | null> {
  return invoke<LoopLaunchRequest | null>('consume_loop_launch_request')
}

export async function getLoopLaunchRequestPath(): Promise<string> {
  return invoke<string>('get_loop_launch_request_path')
}

export function dispatchLoopLaunchRequest(value: QueueLoopLaunchRequest): void {
  window.dispatchEvent(
    new CustomEvent<QueueLoopLaunchRequest>(LOOP_LAUNCH_EVENT, {
      detail: normalizeLoopLaunchRequest(value),
    })
  )
}

