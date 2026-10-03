/**
 * Axis and pole labels for the 3D scene, drawn as text onto a small 2D canvas and used as a sprite texture. No font file or
 * network request is involved: the browser's own text rendering is used. Where no 2D canvas exists (a test environment), no
 * texture is made and the label is simply not drawn; the text alternative beside the view carries the information regardless.
 */
import { CanvasTexture } from 'three'
import { COLORS } from './sceneConstants'

const WIDTH = 256
const HEIGHT = 128

export interface LabelSpec {
  /** First line (large): the state, e.g. `|0⟩`. */
  title: string
  /** Optional second line (small): the axis, e.g. `+z`. */
  subtitle?: string
  /** Fill colour of the title. */
  color?: string
}

/** A canvas texture for the label, or `null` when text cannot be drawn here. The caller disposes it. */
export function makeLabelTexture({ title, subtitle, color = COLORS.label }: LabelSpec): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.clearRect(0, 0, WIDTH, HEIGHT)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  // A dark halo first, so a label stays readable where an axis or the vector passes behind it.
  ctx.strokeStyle = COLORS.halo
  ctx.lineWidth = 9

  const mono = "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace"
  const titleY = subtitle ? 48 : 64
  ctx.font = `600 52px ${mono}`
  ctx.strokeText(title, WIDTH / 2, titleY)
  ctx.fillStyle = color
  ctx.fillText(title, WIDTH / 2, titleY)

  if (subtitle) {
    ctx.font = `500 34px ${mono}`
    ctx.strokeText(subtitle, WIDTH / 2, 98)
    ctx.fillStyle = COLORS.labelMuted
    ctx.fillText(subtitle, WIDTH / 2, 98)
  }

  const texture = new CanvasTexture(canvas)
  texture.anisotropy = 4
  return texture
}

/**
 * Sprite size for a label made by `makeLabelTexture`: the canvas's own 2:1 shape. Labels are NOT size-attenuated (they stay one
 * readable size however far the pole is from the camera, and however far the learner zooms), so this is a screen-relative scale.
 */
export const LABEL_SCALE: readonly [number, number, number] = [0.15, 0.075, 1]
