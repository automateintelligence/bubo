const test = require('node:test')
const assert = require('node:assert/strict')

const { shouldTriggerReview } = require('../scripts/lib/trigger')

test('turn reviews respect cooldown while manual reviews bypass it', () => {
  const now = 50000
  const state = { lastTriggerAt: { turn: 40000 } }
  const config = { cooldowns: { turnMs: 30000, signalMs: 5000 } }

  assert.equal(shouldTriggerReview({ reason: 'turn', now, state, config }).allowed, false)
  assert.equal(shouldTriggerReview({ reason: 'manual', now, state, config }).allowed, true)
})
