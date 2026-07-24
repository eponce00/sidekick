const dashboard = await import(new URL('../src/dashboard.js', import.meta.url).href)

if (dashboard.populationRows.length !== 3) throw new Error('expected three population rows')
if (dashboard.latestPopulation() !== 10980000) throw new Error('latest population is incorrect')

console.log('SIDEKICK_GROUP_VERIFY_OK')
