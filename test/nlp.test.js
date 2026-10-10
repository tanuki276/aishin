const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchQuery, resolveCoref, isExplicitTopicSwitch } = require('../api/lib/nlp');

function ctx(topic) {
  return { lastKeyword: topic, lastEntities: [{ title: topic }] };
}

test('short follow-up keeps the previous topic', () => {
  assert.equal(buildSearchQuery('何歳で死んだ？', ctx('徳川家康')), '徳川家康 何歳で死んだ？');
});

test('pronoun follow-up resolves to the previous entity', () => {
  assert.equal(resolveCoref('彼は何をした人？', ctx('織田信長')), '織田信長');
  assert.equal(buildSearchQuery('彼は何をした人？', ctx('織田信長')), '織田信長 彼は何をした人？');
});

test('explicit topic switch does not inherit old context', () => {
  assert.equal(isExplicitTopicSwitch('ところで量子力学って何？'), true);
  assert.equal(buildSearchQuery('ところで量子力学って何？', ctx('徳川家康')), 'ところで量子力学って何？');
});
