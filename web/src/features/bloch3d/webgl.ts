/**
 * Whether this browser can draw WebGL at all. Asked once; a page where it fails (WebGL turned off, a blocked GPU, a test
 * environment) shows the flat projection instead and says so. Nothing else depends on the answer.
 */
let cached: boolean | null = null

export function webglSupported(): boolean {
  if (cached !== null) return cached
  try {
    if (typeof WebGLRenderingContext === 'undefined') {
      cached = false
    } else {
      const canvas = document.createElement('canvas')
      cached = Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
    }
  } catch {
    cached = false
  }
  return cached
}

/** Test hook: forget the cached answer. */
export function resetWebglSupportCache(): void {
  cached = null
}
