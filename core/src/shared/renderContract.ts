import type { AuthoredMotionSpace } from './track'

export interface RenderContractInput {
  motionSpace?: AuthoredMotionSpace
  displayNumbers?: Array<[string, number]>
  focusedDisplay?: number
  display?: number
}

/** Returns why a render payload is unsafe, or null when it is self-consistent. */
export function renderContractError(job: RenderContractInput): string | null {
  if (job.motionSpace === undefined || job.motionSpace.displays.length < 2) return null
  if (job.focusedDisplay === undefined) {
    return 'multi-display render requires focusedDisplay'
  }
  if (job.focusedDisplay !== job.motionSpace.focusedIndex) {
    return 'multi-display render focusedDisplay disagrees with motionSpace'
  }
  if (job.displayNumbers === undefined) {
    return 'multi-display render requires global displayNumbers'
  }
  if (!job.motionSpace.displays.some((display) => display.index === job.focusedDisplay)) {
    return 'multi-display render focusedDisplay is not declared in motionSpace'
  }
  if (
    job.display !== undefined
    && !job.motionSpace.displays.some((display) => display.index === job.display)
  ) {
    return 'multi-display render display is not declared in motionSpace'
  }
  return null
}
