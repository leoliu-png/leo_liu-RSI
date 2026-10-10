export const MODEL_NAME = "minimax-m3";
export const MODEL_BASE_URL = "https://litellm.feedmob.it.com";
// Changing the generator or judge starts a separate comparison epoch.
export const MODEL_PROFILE = "litellm-minimax-m3";
export const MODEL_PROVIDER = "LiteLLM";
export const MODEL_SUPPORTS_SEED = false;
// MiniMax's generation limit includes thinking, not just visible answer text.
export const MODEL_TOKEN_LIMITS = { summary: 4096, strategy: 4096, candidate: 6144, judge: 8192 };
export const MAX_MODEL_OUTPUT_TOKENS = 16384;
export const MODEL_REQUEST_TIMEOUT_MS = 150000;
export const MODEL_CALL_RESERVE_MS = 2 * MODEL_REQUEST_TIMEOUT_MS + 20000;
export const PREVIOUS_STATE_KEYS = ["rsi:v4:openrouter-laguna-s21:state", "rsi:v4:openrouter-nemotron3-ultra:state", "rsi:v4:state", "rsi:v3:state", "rsi:v2:state"];
