const assert = require('node:assert/strict');
const { failureDetails, nextAttemptPlan } = require('../services/invoiceOcrQueue');

const blocked = failureDetails(Object.assign(new Error('No available channel for model'), {
  diagnostics: { route_count: 4, attempts: [{ http_status: 404, error: 'model_not_found' }] },
}));
assert.equal(blocked.blockRouteForBatch, true);

const rateLimited = failureDetails(Object.assign(new Error('Rate limit exceeded'), {
  diagnostics: { route_count: 4, attempts: [{ http_status: 429, error: 'rate_limit_exceeded' }] },
}));
assert.equal(rateLimited.blockRouteForBatch, true);

const timeout = failureDetails(Object.assign(new Error('Request timed out'), {
  diagnostics: { route_count: 4, attempts: [{ http_status: 504, error: 'deadline exceeded' }] },
}));
assert.equal(timeout.blockRouteForBatch, false);
assert.equal(nextAttemptPlan({ route_index: 3, prompt_version: 'detailed', queue_attempts: 4 }, timeout, 4, 8).shouldRetry, false);

const invalid = failureDetails(Object.assign(new Error('Gemini trả về JSON không hợp lệ'), {
  diagnostics: { route_count: 4, prompt_failures: [{ prompt_version: 'compact' }] },
}));
assert.deepEqual(
  nextAttemptPlan({ route_index: 2, prompt_version: 'compact', queue_attempts: 3 }, invalid, 4, 8),
  { nextRoute: 2, nextPrompt: 'detailed', shouldRetry: true },
);
assert.deepEqual(
  nextAttemptPlan({ route_index: 2, prompt_version: 'detailed', queue_attempts: 4 }, invalid, 4, 8),
  { nextRoute: 3, nextPrompt: 'detailed', shouldRetry: true },
);

console.log('PASS: blocked routes are classified and exhausted routes are not retried.');
