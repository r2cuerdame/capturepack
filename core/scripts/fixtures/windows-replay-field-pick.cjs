'use strict'

function actualObjectPickVerdict(queries) {
  const attemptedPointCount = queries.reduce(
    (count, query) => count + query.visual_pick_expected_count,
    0,
  )
  const successfulPointCount = queries.reduce(
    (count, query) =>
      count + query.picks.filter((pick) => pick.picked_target === true).length,
    0,
  )
  const successfulQueryCount = queries.filter((query) => (
    query.picks.length === query.visual_pick_expected_count
    && query.picks.every((pick) => pick.picked_target === true)
  )).length
  return {
    pass:
      attemptedPointCount > 0
      && successfulQueryCount === queries.length,
    query_count: queries.length,
    successful_query_count: successfulQueryCount,
    attempted_point_count: attemptedPointCount,
    successful_point_count: successfulPointCount,
  }
}

module.exports = { actualObjectPickVerdict }
