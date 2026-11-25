// Provider pin: the settings must never point anywhere but Anthropic, and the
// tripwire predicates must reject everything this machine's OpenRouter setup
// actually produced.
import { pinnedProviderSettings, resolveBridgeModel, scrubProviderEnv, isClaudeModel, isAnthropicMessageId, ANTHROPIC_API } from '../src/provider-pin.mjs';
import { classifyRun } from '../src/provider-health.mjs';

let pass = 0; const failures = [];
const ok = (label, cond) => (cond ? pass++ : failures.push(label));

const s = pinnedProviderSettings('claude-opus-5');
ok('base URL is Anthropic', s.env.ANTHROPIC_BASE_URL === ANTHROPIC_API);
ok('OpenRouter token neutralised', s.env.ANTHROPIC_AUTH_TOKEN === '' && s.env.OPENROUTER_API_KEY === '');
// Values only: the pin deliberately sets OPENROUTER_API_KEY to '', so the key
// name itself legitimately contains "openrouter".
ok('no value anywhere points at openrouter',
  ![s.model, ...s.fallbackModel, ...Object.values(s.env)].some((v) => /openrouter/i.test(String(v))));
ok('every model field is a Claude model', [s.model, ...s.fallbackModel, s.env.ANTHROPIC_MODEL, s.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, s.env.CLAUDE_CODE_SUBAGENT_MODEL].every(isClaudeModel));
ok('feature flags cleared with "", not "0"', s.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '');

// models this machine's OpenRouter routing actually returned
for (const m of ['openrouter/free', 'inclusionai/ling-3.0-flash-fin:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'anthropic/claude-opus-5', 'gpt-4o', '<synthetic>', '', null])
  ok(`rejects model ${JSON.stringify(m)}`, !isClaudeModel(m));
for (const m of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'])
  ok(`accepts model ${m}`, isClaudeModel(m));
ok('msg_ id accepted', isAnthropicMessageId('msg_01XyZ'));
ok('OpenRouter gen- id rejected', !isAnthropicMessageId('gen-1757912345-abc'));

ok('empty BRIDGE_MODEL → default Claude', isClaudeModel(resolveBridgeModel('')));
ok('alias resolves', resolveBridgeModel('Sonnet') === 'claude-sonnet-5');
let threw = false; try { resolveBridgeModel('openrouter/free'); } catch { threw = true; }
ok('non-Claude BRIDGE_MODEL is refused', threw);

const env = scrubProviderEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'x',
  OPENROUTER_API_KEY: 'y', CLAUDE_CODE_SUBAGENT_MODEL: 'openrouter/free', CLAUDE_BRIDGE_RUN_ID: 'r1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
ok('scrub removes routing vars', !('ANTHROPIC_BASE_URL' in env) && !('ANTHROPIC_AUTH_TOKEN' in env) && !('OPENROUTER_API_KEY' in env) && !('CLAUDE_CODE_SUBAGENT_MODEL' in env));
ok('scrub keeps everything else', env.PATH === '/bin' && env.HOME === '/h' && env.CLAUDE_BRIDGE_RUN_ID === 'r1' && env.CLAUDE_CODE_ENTRYPOINT === 'cli');

// the failure the pin produces when there is no Claude login must be caught
ok('"Not logged in" classified as auth', classifyRun({ status: 'error',
  errors: ['Claude Code returned an error result (subtype=success): Not logged in · Please run /login'], summary: 'Not logged in · Please run /login' }) === 'auth');

if (failures.length) { console.error(`\n✗ ${failures.length} provider-pin failure(s), ${pass} passed:\n`); for (const f of failures) console.error('  - ' + f); process.exit(1); }
console.log(`✓ all ${pass} provider-pin tests passed`);
