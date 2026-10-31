import assert from 'node:assert/strict';
import { clampIntentFit, classifyIntentFit } from '../src/tools/mapSearch';

assert.equal(classifyIntentFit(0.8), 'high');
assert.equal(classifyIntentFit(0.55), 'medium');
assert.equal(classifyIntentFit(0.549), 'low');
assert.equal(clampIntentFit(1.4), 1);
assert.equal(clampIntentFit(-1), 0);
assert.equal(clampIntentFit('nope'), 0.75);

console.log('analyzer scoring: intent_fit thresholds passed');
