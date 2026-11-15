import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// run.mjs gives each execution a fresh, writable probe HOME. Only fictional
// identities and measured metadata belong here, never tokens or message bodies.
export function recordProbeEvidence(key: string, observation: unknown): void {
  const file = 'transport-observations.json';
  const observations = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  observations[key] = observation;
  writeFileSync(file, JSON.stringify(observations, null, 2) + '\n');
}
