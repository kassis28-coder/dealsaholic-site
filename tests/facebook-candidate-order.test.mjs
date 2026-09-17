import assert from "node:assert/strict";
import test from "node:test";
import { facebookCandidatePositions } from "../netlify/functions/lib/facebook-candidate-order.mjs";

test("checks newest site deals before resuming an older cursor", () => {
  const positions = facebookCandidatePositions(1_000, 700, 400, 200);

  assert.deepEqual(positions.slice(0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(positions.slice(200, 205), [700, 701, 702, 703, 704]);
  assert.equal(positions.length, 400);
  assert.equal(new Set(positions).size, 400);
});

test("does not duplicate positions when the cursor overlaps newest deals", () => {
  const positions = facebookCandidatePositions(250, 100, 250, 200);

  assert.equal(positions.length, 250);
  assert.equal(new Set(positions).size, 250);
  assert.deepEqual(positions.slice(0, 3), [0, 1, 2]);
});
