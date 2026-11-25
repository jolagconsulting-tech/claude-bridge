// Pin every bridge run to Anthropic's own API, whatever ~/.claude/settings.json
// says. On this machine the user-level settings deliberately route interactive
// Claude Code to OpenRouter free models; bridge runs inherited that silently
// until a 429 "free-models-per-day" exposed it.
//
// How the pin works (verified by probe, not assumed):
//  - Flag settings (--settings) outrank user, project and local settings, so
//    the env block and model below win over ~/.claude/settings.json.
//  - Routing variables are also scrubbed from the spawn environment, so a
//    server started from a shell that exports them (~/.zshrc does here) can't
//    leak them into a run.
//  - Empty ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY neutralise the OpenRouter
//    token. Claude Code then uses the stored Claude login, and with no valid
//    login it refuses ("Not logged in") rather than falling back to anything.
export const ANTHROPIC_API = 'https://api.anthropic.com';
export const CLAUDE_MODELS = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
export const DEFAULT_MODEL = CLAUDE_MODELS.opus;

/** A first-party Claude model id. Rejects gateway forms like "anthropic/claude-opus-5". */
export function isClaudeModel(m) {
  return typeof m === 'string' && /^claude-[a-z0-9.-]+(\[[^\]]*\])?$/i.test(m);
}

/** Anthropic Messages API ids are msg_…; OpenRouter's are gen-…. */
export function isAnthropicMessageId(id) {
  return typeof id === 'string' && id.startsWith('msg_');
}

export function resolveBridgeModel(requested) {
  const m = String(requested || '').trim();
  if (!m) return DEFAULT_MODEL;
  const alias = CLAUDE_MODELS[m.toLowerCase()];
  if (alias) return alias;
  if (isClaudeModel(m)) return m;
  throw new Error(
    `BRIDGE_MODEL="${m}" is not a Claude model. The bridge only runs on Anthropic's API — ` +
    'set BRIDGE_MODEL to opus, sonnet, haiku or a claude-* model id.'
  );
}

export function pinnedProviderSettings(model) {
  return {
    model,
    fallbackModel: [model === CLAUDE_MODELS.sonnet ? CLAUDE_MODELS.haiku : CLAUDE_MODELS.sonnet],
    env: {
      ANTHROPIC_BASE_URL: ANTHROPIC_API,
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_MODELS.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_MODELS.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODELS.haiku,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      // Empty rather than "0": a plain truthiness check would read "0" as on.
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '',
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
    },
  };
}

const ROUTING_VAR = /^(ANTHROPIC_|OPENROUTER_|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_(SUBAGENT_MODEL|ENABLE_GATEWAY_MODEL_DISCOVERY|DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT)$)/;

export function scrubProviderEnv(src) {
  const env = {};
  for (const [k, v] of Object.entries(src)) if (!ROUTING_VAR.test(k)) env[k] = v;
  return env;
}
