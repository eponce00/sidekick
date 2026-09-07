function smokeDuration(value = '8') {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 120) {
    throw new Error('SIDEKICK_SMOKE_SECONDS must be an integer from 1 to 120.')
  }
  return Number(value) * 1000
}

// Install listeners immediately after spawn: exitCode alone misses signal deaths,
// and a failed exec emits error rather than a successful startup/exit sequence.
function observeStartup(child, milliseconds) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onError = (error) => finish(new Error(`Packaged app failed to start: ${error.message}`))
    const onExit = (code, signal) =>
      finish(new Error(`Packaged app exited during smoke test (code ${code}, signal ${signal}).`))
    const timer = setTimeout(() => finish(), milliseconds)
    child.once('error', onError)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode)
    }
  })
}

module.exports = { smokeDuration, observeStartup }
