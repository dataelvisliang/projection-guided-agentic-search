import assert from 'node:assert/strict';
import { buildMapSearchPlan, evaluateCoverageWarning, fuseRanks, normalizeSearchText, selectSpreadIslands, validateTopicSql } from '../src/tools/mapSearch';

assert.equal(normalizeSearchText("Pepper & Beef's"), 'pepper and beefs');
assert.equal(normalizeSearchText('Oak—tannin'), 'oak tannin');

const plan = buildMapSearchPlan('pepper & beef', ['syrah']);
assert.ok(plan.directPhrases.includes('pepper and beef'));
assert.ok(plan.directTokens.includes('pepper'));
assert.ok(plan.expandedTerms.includes('peppers') || plan.directTokens.includes('peppers'));

const fused = fuseRanks([{ name: 'phrase', ids: ['b', 'a'] }, { name: 'any_token', ids: ['a'] }]);
assert.equal(fused[0].id, 'a');
assert.equal(fused[0].recall_pass_count, 2);

const islands = selectSpreadIslands([
    { gx: 0, gy: 0, support: 10 },
    { gx: 1, gy: 0, support: 9 },
    { gx: 4, gy: 4, support: 8 }
]);
assert.deepEqual(islands.map(cell => cell.gx), [0, 4, 1]);

assert.equal(evaluateCoverageWarning(50, 1, 1, 1), null);
assert.equal(evaluateCoverageWarning(200, 2, 1, 4)?.code, 'very_low_projection_coverage');
assert.equal(validateTopicSql('SELECT FLOOR(projection_x / 48) FROM reviews'), 'Bin with FLOOR((projection_x - min_x) / range_x * N), not projection_x / N');
assert.equal(validateTopicSql('-- note\nSELECT COUNT(*) AS n FROM reviews'), null);
assert.match(validateTopicSql('DROP TABLE reviews') || '', /SELECT or WITH/);

console.log('map search: normalization, fusion, islands, and SQL guard passed');
