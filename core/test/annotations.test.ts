import { computeDisplayNumbers, nextDisplayNumber, planNumberPins } from '../src/shared/types'
import type { Annotation, BoxAnnotation } from '../src/shared/types'
import assert from 'node:assert/strict'

// SPEC §8.3 & §8.5 conformance test suite:
// BoxAnnotation.created_at is OPTIONAL (SPEC §8.3).
// When omitted, computeDisplayNumbers sorts undated boxes after dated boxes,
// preserving deterministic ordering without type errors or NaN issues (SPEC §8.5).

function testBoxAnnotationCreatedIsOptional(): void {
  // Conforming box omitting created_at satisfies BoxAnnotation without dummy values or casts
  const boxWithoutCreatedAt: BoxAnnotation = {
    annotation_id: 'ann_000001',
    type: 'box',
    bounds: { x: 10, y: 10, width: 100, height: 100 },
  }
  assert.equal(boxWithoutCreatedAt.created_at, undefined)
  assert.equal('created_at' in boxWithoutCreatedAt, false)
}

function testUndatedBoxesSortAfterDatedBoxes(): void {
  const dated: Annotation = {
    annotation_id: 'ann_dated1',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    created_at: '2026-07-29T18:00:00+09:00',
    z: 99,
  }
  const undated: Annotation = {
    annotation_id: 'ann_undat1',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    z: 1,
  }

  // Dated box outranks undated box even when undated has lower z
  const result1 = computeDisplayNumbers([undated, dated])
  assert.equal(result1.get('ann_dated1'), 1)
  assert.equal(result1.get('ann_undat1'), 2)

  // Array order does not change the outcome
  const result2 = computeDisplayNumbers([dated, undated])
  assert.equal(result2.get('ann_dated1'), 1)
  assert.equal(result2.get('ann_undat1'), 2)
}

function testUndatedBoxesSortByZThenAnnotationId(): void {
  const undatedLowZ: Annotation = {
    annotation_id: 'ann_z_low',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    z: 2,
  }
  const undatedHighZ: Annotation = {
    annotation_id: 'ann_z_high',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    z: 10,
  }

  const resultZ = computeDisplayNumbers([undatedHighZ, undatedLowZ])
  assert.equal(resultZ.get('ann_z_low'), 1)
  assert.equal(resultZ.get('ann_z_high'), 2)

  // Equal z falls back to lexicographical annotation_id
  const tieA: Annotation = {
    annotation_id: 'ann_alpha',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    z: 5,
  }
  const tieB: Annotation = {
    annotation_id: 'ann_beta',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    z: 5,
  }

  const resultTie = computeDisplayNumbers([tieB, tieA])
  assert.equal(resultTie.get('ann_alpha'), 1)
  assert.equal(resultTie.get('ann_beta'), 2)
}

function testUndatedBoxesOmittingZFallbackToArrayPosition(): void {
  const first: Annotation = {
    annotation_id: 'ann_pos1',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
  }
  const second: Annotation = {
    annotation_id: 'ann_pos2',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
  }

  const forward = computeDisplayNumbers([first, second])
  assert.equal(forward.get('ann_pos1'), 1)
  assert.equal(forward.get('ann_pos2'), 2)

  const reverse = computeDisplayNumbers([second, first])
  assert.equal(reverse.get('ann_pos2'), 1)
  assert.equal(reverse.get('ann_pos1'), 2)
}

function testUnparseableCreatedAtTreatedAsUndated(): void {
  const dated: Annotation = {
    annotation_id: 'ann_valid_date',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    created_at: '2026-07-29T18:00:00+09:00',
    z: 100,
  }
  const invalidDate: Annotation = {
    annotation_id: 'ann_invalid_date',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    created_at: 'not-an-iso-date',
    z: 1,
  }
  const emptyStringDate: Annotation = {
    annotation_id: 'ann_empty_date',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    created_at: '',
    z: 2,
  }

  const result = computeDisplayNumbers([invalidDate, emptyStringDate, dated])
  assert.equal(result.get('ann_valid_date'), 1)
  assert.equal(result.get('ann_invalid_date'), 2)
  assert.equal(result.get('ann_empty_date'), 3)
}

function testNumberPinsWithUndatedBoxes(): void {
  const datedEarly: Annotation = {
    annotation_id: 'ann_early',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    created_at: '2026-07-29T18:00:00+09:00',
  }
  const undatedPinned: Annotation = {
    annotation_id: 'ann_undated_pin',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
    number_pin: 1,
  }
  const undatedUnpinned: Annotation = {
    annotation_id: 'ann_undated_unpinned',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    numbered: true,
  }

  // Pin 1 is claimed by undatedPinned, datedEarly takes slot 2, undatedUnpinned takes slot 3
  const result = computeDisplayNumbers([undatedUnpinned, datedEarly, undatedPinned])
  assert.equal(result.get('ann_undated_pin'), 1)
  assert.equal(result.get('ann_early'), 2)
  assert.equal(result.get('ann_undated_unpinned'), 3)

  assert.equal(nextDisplayNumber([datedEarly, undatedPinned], 'ann_new'), 3)
}

function run(): void {
  testBoxAnnotationCreatedIsOptional()
  testUndatedBoxesSortAfterDatedBoxes()
  testUndatedBoxesSortByZThenAnnotationId()
  testUndatedBoxesOmittingZFallbackToArrayPosition()
  testUnparseableCreatedAtTreatedAsUndated()
  testNumberPinsWithUndatedBoxes()
  console.log('PASS annotations.test.ts: all tests passed successfully.')
}

run()
