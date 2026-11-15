export function combineStatus(results) {
  if (results.some(result => result.status === 'failed')) return 'failed';
  if (results.some(result => result.status === 'blocked')) return 'blocked';
  if (results.length === 0 || results.some(result => result.status !== 'passed')) return 'not-run';
  return 'passed';
}

export function evaluateScenario(scenario, { platform, tests, isolationStatus = 'not-run', reportStatus = 'not-run' }) {
  if (scenario.platform !== platform) return { ...scenario, status: 'not-run', reason: `Requires ${scenario.platform}; actual runtime is ${platform}.`, evidence: [] };
  const evidence = scenario.tests.map(reference => {
    if (reference.runner) return {
      ...reference,
      status: reference.runner === 'isolation' ? isolationStatus : reportStatus,
    };
    const found = tests.filter(test => test.file === reference.file && (!reference.name || test.name === reference.name));
    return { ...reference, status: combineStatus(found), matchingTests: found.length };
  });
  return { ...scenario, status: combineStatus(evidence), reason: scenario.gap, evidence };
}
