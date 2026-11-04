// Per-model request parameters for the cloud providers. Kept free of Electron
// so test/cloud-params.test.js can run these rules under plain Node.

// Anthropic's "thinking" and "effort" rules differ by model, and a wrong value
// is a 400 rather than a warning:
//   Opus 5.5, Fable 5.x  can't turn thinking off; lower effort is the only dial
//   Sonnet 5.5           `disabled` is a 400; `between_tools` is its off switch
//   Haiku 5.5            `budget_tokens` is a 400; `disabled` still works
//   Haiku 4.x            `budget_tokens` is the only way to turn thinking on
// Everything returned here is merged straight into the request body.
function anthropicThinkingParams(model, enabled) {
  const on = { type: 'adaptive', display: 'summarized' };
  if (/^claude-haiku-4/i.test(model)) {
    // budget_tokens must stay below the 64K max_tokens sent with every request.
    return enabled ? { thinking: { type: 'enabled', budget_tokens: 10000 } } : {};
  }
  if (/^claude-(opus-5-5|fable-5)/i.test(model)) {
    return enabled
      ? { thinking: on, output_config: { effort: 'high' } }
      : { output_config: { effort: 'low' } };
  }
  if (/^claude-sonnet-5-5/i.test(model)) {
    return { thinking: enabled ? on : { type: 'between_tools' } };
  }
  if (/^claude-haiku-5/i.test(model)) {
    return { thinking: enabled ? on : { type: 'disabled' } };
  }
  return enabled ? { thinking: on } : {};
}

// Models whose safety classifiers can decline a request and that have a
// server-side fallback. Haiku 5.5 has classifiers but no fallback, so sending
// the parameter there would change nothing.
function anthropicUsesFallbacks(model) {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/i.test(model);
}

const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Gemini 3+ takes a thinking level and has no true off switch, so "off" means
// the lowest level that model accepts. The accepted levels differ by model and
// an unsupported one is an error. Gemini 2.x uses a different field, so it gets
// no thinking config at all and runs with its own default.
function geminiThinkingConfig(model, enabled) {
  if (/^gemini-[012]\b|^gemini-[012]\./i.test(model)) return undefined;
  if (enabled) return { thinkingLevel: 'HIGH', includeThoughts: true };
  const hasMinimal = /(flash-lite|3\.6-flash|^gemini-3-flash)/i.test(model);
  return { thinkingLevel: hasMinimal ? 'MINIMAL' : 'LOW' };
}

function imageMime(base64) {
  const head = String(base64 || '').slice(0, 12);
  if (head.startsWith('iVBOR')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lG')) return 'image/gif';
  if (head.startsWith('UklG')) return 'image/webp';
  return null;
}

function requireImageMime(base64, allowed, label) {
  const mime = imageMime(base64);
  if (!mime || !allowed.includes(mime)) {
    throw new Error(`${label} can only read PNG, JPEG, ${allowed.includes('image/gif') ? 'GIF, ' : ''}and WebP images. Convert this image and attach it again.`);
  }
  return mime;
}

function lastUserIndex(list) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') return i;
  return -1;
}

function addImagesToAnthropic(messages, images) {
  if (!images?.length) return;
  const i = lastUserIndex(messages);
  if (i < 0) return;
  const blocks = images.map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: requireImageMime(data, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], 'Claude'), data }
  }));
  const text = messages[i].content;
  // Claude rejects an empty text block.
  if (typeof text === 'string' && text) blocks.push({ type: 'text', text });
  else if (Array.isArray(text)) blocks.push(...text);
  messages[i].content = blocks;
}

function addImagesToGemini(contents, images) {
  if (!images?.length) return;
  const i = lastUserIndex(contents);
  if (i < 0) return;
  const parts = images.map((data) => ({
    inlineData: { mimeType: requireImageMime(data, ['image/png', 'image/jpeg', 'image/webp'], 'Gemini'), data }
  }));
  contents[i].parts = [...parts, ...contents[i].parts];
}

module.exports = {
  addImagesToAnthropic,
  addImagesToGemini,
  anthropicThinkingParams,
  anthropicUsesFallbacks,
  ANTHROPIC_FALLBACK_BETA,
  geminiThinkingConfig
};
