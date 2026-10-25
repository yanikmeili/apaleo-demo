// Run the allocation agent. Dry-run by default.
//   npm run agent                     -> proposals for tomorrow, nothing written
//   npm run agent -- --date 2026-10-30
//   npm run agent -- --show-input     -> print what the model would receive, no model call
//   npm run agent:apply               -> same, then assign units in Apaleo
import fs from 'node:fs';
import path from 'node:path';
import { buildInput, proposeAssignments, validateProposals, applyDecisions, renderReport, tomorrowIso } from '../src/allocationAgent.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const date = opt('--date', tomorrowIso());
const apply = flag('--apply');

const input = await buildInput(date);
console.log(`\n${input.reservations.length} arrival(s) on ${date} without a room at ${input.propertyId}.`);
if (!input.reservations.length) process.exit(0);

if (flag('--show-input')) {
  // No process.exit here: a large console.log to a pipe is flushed asynchronously.
  process.stdout.write(JSON.stringify(input, null, 2) + '\n');
} else {
  await run();
}

async function run() {
const proposals = await proposeAssignments(input);
const { decisions, unknown } = validateProposals(input, proposals);
const final = apply ? await applyDecisions(decisions) : decisions;

const report = renderReport({ date, decisions: final, unknown, apply });
console.log(`\n${report}\n`);

fs.mkdirSync('reports', { recursive: true });
const file = path.join('reports', `allocation-${date}${apply ? '-applied' : '-dryrun'}.md`);
fs.writeFileSync(file, report);
console.log(`Report written to ${file}`);
if (!apply) console.log('Dry-run: nothing was written to Apaleo. Re-run with --apply to assign.');
}
