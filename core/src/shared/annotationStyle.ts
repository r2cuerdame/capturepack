import type { Annotation } from './types'

/** Authored rectangle: the user chose pixels, so red means "manual evidence". */
export const MANUAL_BOX_COLOR = '#FF3B30'

/** Semantic rectangle: CapturePack identified an object, so blue means "object evidence". */
export const SEMANTIC_BOX_COLOR = '#0A84FF'

/** Whether persisted object evidence, rather than the user, owns the rectangle. */
export function annotationHasSemanticGeometry(
  annotation: Pick<Annotation, 'target' | 'tracking'>,
): boolean {
  return annotation.target !== undefined || annotation.tracking?.enabled === true
}

/**
 * One colour rule for every annotation consumer.
 *
 * A stored colour is user/legacy data and always wins. Only annotations that do
 * not declare one receive the semantic default: target/tracking means blue,
 * while a plain manually authored rectangle means red.
 */
export function annotationColor(
  annotation: Pick<Annotation, 'style' | 'target' | 'tracking'>,
): string {
  if (annotation.style?.color !== undefined) return annotation.style.color
  return annotationHasSemanticGeometry(annotation)
    ? SEMANTIC_BOX_COLOR
    : MANUAL_BOX_COLOR
}
