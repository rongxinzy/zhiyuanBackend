import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { calculateCandidateScore } from '../src/provider-scoring.ts';

function distribution(weights: number[], inflight = weights.map(() => 0)) {
  const counts = weights.map(() => 0);
  for (let index = 0; index < 10_000; index++) {
    const session = createHash('sha256').update(`user:${index}:session`).digest('hex');
    const scores = weights.map((weight, key) =>
      calculateCandidateScore(session, `pool:key-${key + 1}`, weight, 1, inflight[key]),
    );
    counts[scores.indexOf(Math.max(...scores))]++;
  }
  return counts;
}

test('equal keys distribute 10,000 new sessions within two percentage points', () => {
  for (const size of [4, 6]) {
    const counts = distribution(Array.from({ length: size }, () => 1));
    for (const count of counts)
      assert.ok(Math.abs(count / 10_000 - 1 / size) < 0.02, String(counts));
    console.log(`Equal ${size}-key distribution: ${counts.join(', ')}`);
  }
});

test('weighted allocation follows 1:2:3 capacity and diverts from busy keys', () => {
  const counts = distribution([1, 2, 3]);
  counts.forEach((count, index) => assert.ok(Math.abs(count / 10_000 - (index + 1) / 6) < 0.02));
  const busy = distribution([1, 1, 1], [9, 0, 0]);
  assert.ok(busy[0] < 600, String(busy));
  console.log(
    `Weighted distribution: ${counts.join(', ')}; busy-key distribution: ${busy.join(', ')}`,
  );
});
