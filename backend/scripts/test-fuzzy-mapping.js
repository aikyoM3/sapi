const assert = require('node:assert/strict');
const { fuzzyMappingScore, chooseTolerantMapping } = require('../services/invoiceMappingService');

const noisyLeft = 'eMì Kkmi tôm chua cay';
const noisyRight = 'cMì Kkmi tôm chua cay';
assert(fuzzyMappingScore(noisyLeft, noisyRight) >= 0.82, 'One OCR character error should match');
assert.equal(fuzzyMappingScore('Milo 180ml', 'Milo 110ml'), 0, 'Different volumes must never fuzzy-match');
assert.equal(fuzzyMappingScore('Milo 180 ml', 'milo-180ML'), 1, 'Formatting-only differences are exact after normalization');
assert.equal(fuzzyMappingScore('Milo 180ml', 'Milo 180g'), 0, 'Different measurement units must not fuzzy-match strongly');

const selected = chooseTolerantMapping([
  { product_id: 1, provider_product_name: noisyLeft },
  { product_id: 2, provider_product_name: 'Mì Kokomi bò hầm' },
], noisyRight);
assert.equal(selected.product_id, 1);
assert.equal(selected.mapping_match_type, 'FUZZY');

const ambiguous = chooseTolerantMapping([
  { product_id: 1, provider_product_name: 'Mì Kokomi tôm chua cay' },
  { product_id: 2, provider_product_name: 'Mì Kokomi tôm chua cay loại mới' },
], 'Mì Kokomi tôm chua cay loại');
assert.equal(ambiguous, null, 'Close candidates must require human selection');

const aliases = chooseTolerantMapping([
  { product_id: 1, provider_product_name: noisyLeft },
  { product_id: 1, provider_product_name: 'e Mi Kkmi tom chua cay' },
], noisyRight);
assert.equal(aliases.product_id, 1, 'Aliases of one product are not ambiguity');

console.log('PASS: OCR-tolerant mapping accepts text noise, rejects numeric/unit conflicts and ambiguity.');
