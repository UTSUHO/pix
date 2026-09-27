const test = require('node:test');
const assert = require('node:assert/strict');
const { satisfies } = require('../src/host/semver');

test('semver satisfies common engine ranges', () => {
  assert.equal(satisfies('22.19.0', '>=22.19'), true);
  assert.equal(satisfies('22.18.9', '>=22.19'), false);
  assert.equal(satisfies('18.0.0', '>=18'), true);
  assert.equal(satisfies('22.1.0', '^22.0.0'), true);
  assert.equal(satisfies('23.0.0', '^22.0.0'), false);
  assert.equal(satisfies('0.2.5', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('1.2.5', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.5.0', '1.x'), true);
  assert.equal(satisfies('2.0.0', '1.x'), false);
  assert.equal(satisfies('20.0.0', '>=18 <23'), true);
  assert.equal(satisfies('24.0.0', '>=18 <23'), false);
  assert.equal(satisfies('22.0.0', '^20 || >=22'), true);
  assert.equal(satisfies('21.0.0', '^20 || >=22'), false);
  assert.equal(satisfies('anything', '*'), true);
  assert.equal(satisfies('1.2.3', ''), true);
});
