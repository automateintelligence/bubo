function cooldownFor(reason, config) {
  if (reason === 'turn') return config.cooldowns.turnMs
  if (reason === 'manual') return 0
  return config.cooldowns.signalMs
}

function shouldTriggerReview({ reason, now, state, config }) {
  const last = state.lastTriggerAt?.[reason] || 0
  const cooldown = cooldownFor(reason, config)

  if (cooldown === 0) {
    return { allowed: true, reason }
  }

  return {
    allowed: now - last >= cooldown,
    reason
  }
}

module.exports = { shouldTriggerReview }
