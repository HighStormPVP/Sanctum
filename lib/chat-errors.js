// What a failed reply says. main.js works out what kind of failure it was, because only it knows
// whether Ollama had taken the request, and the renderer turns that into words. Loaded by the
// renderer through a <script> tag as ChatErrors, and by main.js and the tests through require.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ChatErrors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Node's fetch puts these on the error's cause. Electron's net.fetch has no cause and says it
  // in the message instead, as net::ERR_...
  const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
  const UNREACHABLE_NET = /\bnet::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)\b/;

  // 'unreachable': nothing answered, so Ollama isn't running or isn't where it's meant to be.
  // 'partway': Ollama took the request and replied, then the reply broke off.
  // 'failed': something answered and hung up before replying.
  // 'answered' isn't from here: it's main.js for an error status, or Ollama's own error line.
  function ollamaFailureKind(err, { accepted = false } = {}) {
    if (accepted) return 'partway';
    const code = err?.cause?.code ?? err?.code;
    if (UNREACHABLE_CODES.has(code)) return 'unreachable';
    if (UNREACHABLE_NET.test(String(err?.message ?? ''))) return 'unreachable';
    return 'failed';
  }

  // The error as one line, with its cause, which is where Node's fetch keeps the reason.
  function failureLine(err) {
    if (typeof err === 'string') return err;
    const message = String(err?.message || err || 'unknown error');
    const cause = err?.cause?.message;
    return cause && cause !== message ? `${message} (${cause})` : message;
  }

  const underneath = (s) => `\n\n_Underlying error: ${s}_`;

  function cloudErrorText(provider, s) {
    const label = provider === 'anthropic' ? 'Anthropic' : provider === 'google' ? 'Google' : provider;
    const hint = /fetch failed|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|net::ERR_/i.test(s)
      ? `\n\n_Network error — check your internet connection. If your machine is online, ${label}'s API may be having a brief outage; try again in a minute._`
      : '\n\n_Double-check your API key in **Settings → API Keys**, and confirm the model id is current._';
    return `**${label} API error.** ${s}${hint}`;
  }

  // `provider` is the chat's, from pickProvider: a cloud error never gets Ollama's words.
  function chatErrorText({ provider = 'ollama', error, errorKind, modality } = {}) {
    const s = String(error ?? '');
    if (provider !== 'ollama') return cloudErrorText(provider, s);

    const memory = s.match(/requires more system memory \(([\d.]+ GiB)\) than is available \(([\d.]+ GiB)\)/i);
    if (memory) {
      const isAgent = modality === 'agent';
      const smaller = isAgent ? 'Hermes 3 8B (~5 GB)' : 'Llama 3.2 3B (~2 GB)';
      return `**Out of memory.** This model needs **${memory[1]}** but only **${memory[2]}** is available on your machine right now.\n\nTry switching to a smaller model:\n- For ${isAgent ? 'agentic' : 'general'} chats: **${smaller}**\n- Or free up memory by closing other apps / models (Ollama keeps the most recent model loaded — running \`ollama stop <other-model>\` in a terminal can help).\n\nUse the model picker in the top right of this chat.`;
    }
    const noModel = s.match(/model '([^']+)' not found/i);
    if (noModel) {
      return `Model **${noModel[1]}** isn't installed. Click its row in the model picker (top right) and use the download icon to pull it.`;
    }

    if (errorKind === 'unreachable') {
      return `Couldn't reach Ollama. Make sure the Ollama tray app is running — the status pill in the sidebar should be green.${underneath(s)}`;
    }
    if (errorKind === 'partway') return `**Ollama stopped partway through this reply.**${underneath(s)}`;
    if (errorKind === 'failed') return `**Ollama closed the connection before replying.** Try sending again.${underneath(s)}`;
    return `**Ollama returned an error for this request.**${underneath(s)}`;
  }

  return { ollamaFailureKind, failureLine, chatErrorText };
});
