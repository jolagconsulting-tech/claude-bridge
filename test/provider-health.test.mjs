// Provider-health classifier. The false-positive cases matter as much as the
// hits: run reports and tool errors routinely contain "429" or "rate limit".
import { classifyRun, providerVerdict } from '../src/provider-health.mjs';

let pass = 0; const failures = [];
const eq = (label, got, want) => (got === want ? pass++ : failures.push(`${label}: got ${got}, wanted ${want}`));
const NOW = Date.parse('2026-09-15T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600e3).toISOString();
const run = (o) => ({ run_id: 'r', project: 'p', status: 'error', errors: [], summary: '', finished_at: at(1), ...o });

// --- real shapes, taken from this machine's run history ---
eq('OpenRouter 429 (runner line)', classifyRun(run({ status: 'paused_needs_confirmation', errors: [
  'Claude Code returned an error result (api_error_status=429, subtype=success): API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day'] })), 'quota');
eq('OAuth expiry, pre-fix format (text only in summary)', classifyRun(run({ errors: ['Claude Code reported an error result (success).', 'claude exited with code 1. '],
  summary: 'Failed to authenticate: OAuth session expired and could not be refreshed' })), 'auth');
eq('401 via api_error_status', classifyRun(run({ errors: ['Claude Code returned an error result (api_error_status=401): Invalid API key'] })), 'auth');
eq('tripwire status', classifyRun(run({ status: 'provider_mismatch' })), 'provider');

// --- must NOT fire ---
eq('report prose about rate limiting', classifyRun(run({ status: 'completed', summary: 'Added middleware that returns 429 when "Rate limit exceeded".' })), null);
eq('tool error quoting file contents', classifyRun(run({ status: 'completed', errors: ['Edit: <tool_use_error>String not found: if (res.status === 429) { throw new Error("Rate limit exceeded") }'] })), null);
eq('ordinary failed run', classifyRun(run({ errors: ['claude exited with code 1. last stream events: assistant → result'] })), null);

// --- verdict ordering ---
const q = run({ run_id: 'q', errors: ['Claude Code returned an error result (api_error_status=429): Rate limit exceeded'], finished_at: at(2) });
const good = run({ run_id: 'g', status: 'completed', finished_at: at(1) });
eq('newer success clears older 429', providerVerdict([q, good], NOW).ok, true);
eq('429 with nothing newer fails', providerVerdict([q], NOW).ok, false);
eq('killed run is skipped, older 429 still decides', providerVerdict([q, run({ status: 'killed', finished_at: at(1) })], NOW).kind, 'quota');
eq('429 older than a day is stale (quotas reset)', providerVerdict([run({ ...q, finished_at: at(30) })], NOW).ok, true);
eq('401 older than a day still fails (logins do not)', providerVerdict([run({ errors: ['Claude Code returned an error result (api_error_status=401)'], finished_at: at(30) })], NOW).ok, false);
eq('no runs at all is fine', providerVerdict([], NOW).ok, true);

if (failures.length) { console.error(`\n✗ ${failures.length} provider-health failure(s), ${pass} passed:\n`); for (const f of failures) console.error('  - ' + f); process.exit(1); }
console.log(`✓ all ${pass} provider-health tests passed`);
