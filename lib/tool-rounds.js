// Two rules for a local model that has tools.
//
// Sampling: repetition penalties punish a model for repeating tokens, and a tool call has to
// repeat its own tags and the code it carries exactly. On Qwen3.6 35B, with repeat_penalty 1.1
// and the model's own presence_penalty 1.5, 0 of 4 long tool calls came through whole (an
// empty call, a garbled one Ollama couldn't read, and two that thought until they gave up);
// with both off, 4 of 4 did, in about half the time. So a round with tools sends neither.
// Without tools the mild repeat penalty stays, as insurance against loops in long answers,
// and the model keeps whatever presence penalty its own settings give it.
//
// Misses: a round that should have called a tool and didn't would otherwise end the reply
// without a word. missedToolCall says whether it was one, and what kind; the chat loop then
// asks the model once more, at most MAX_NUDGES times a reply.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ToolRounds = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_NUDGES = 2;

  function localSampling({ toolsOffered }) {
    return toolsOffered ? { repeat_penalty: 1, presence_penalty: 0 } : { repeat_penalty: 1.1 };
  }

  // Ollama's words when it can't read a tool call the model wrote.
  const MALFORMED = /XML syntax error|tool call pars/i;

  // Roughly how many tokens some text is: about four characters a token in Latin script, and
  // about one in Chinese, Japanese or Korean. Erring high, so an answer is never taken for lost.
  function tokensIn(text) {
    const all = text || '';
    const latin = all.replace(/[^\x00-\x7f]/g, '').length;
    return latin / 4 + (all.length - latin);
  }

  // Lost means well over twice what arrived, plus some slack, so ordinary differences in
  // counting never look like a lost call. Reasoning that arrives is counted as English.
  function lostOnTheWay({ text, thinkingChars, evalCount }) {
    const arrived = tokensIn(text) + (thinkingChars || 0) / 4;
    return Number.isFinite(evalCount) && evalCount > arrived * 2 + 150;
  }

  // null, or 'malformed' | 'withheld' | 'empty' | 'announced'. `toolsRan` is how many tools
  // already ran in this reply: after those, a round with nothing in it is the model finishing.
  function missedToolCall({ toolsOffered, toolCalls, text, thinkingChars, evalCount, doneReason, streamError, toolsRan = 0 }) {
    if (!toolsOffered) return null;
    // A call that came through runs, even beside one that didn't, and the model carries on
    // from its result.
    if (toolCalls > 0) return null;
    if (streamError) return MALFORMED.test(String(streamError)) ? 'malformed' : null;
    // Asking again would only be cut off at the same place.
    if (doneReason === 'length') return null;
    if (lostOnTheWay({ text, thinkingChars, evalCount })) return 'withheld';
    const said = (text || '').trim();
    if (!said) return toolsRan > 0 ? null : 'empty';
    if (/[:：]$/.test(said)) return 'announced';
    return null;
  }

  // What the model is told, as a user message, when it's asked again.
  function nudgeFor(kind) {
    if (kind === 'malformed') {
      return "Your last tool call couldn't be read: its format was broken. Make the same call again, with every parameter closed properly.";
    }
    return 'Your last reply ended without the tool call it was about to make. If there is still work to do, call the tool now. If the task is finished, say so.';
  }

  // The row in the reply where Sanctum asked again.
  function retryLabel(kind) {
    if (kind === 'malformed') return 'The tool call came out malformed, so Sanctum asked the model to send it again';
    if (kind === 'withheld') return 'The tool call was lost on the way, so Sanctum asked the model to make it again';
    if (kind === 'empty') return 'The model stopped without a reply, so Sanctum asked it to carry on';
    return "The model said it would use a tool and didn't, so Sanctum asked it to";
  }

  // The note when asking again didn't help either.
  function giveUpNote(kind, detail) {
    if (kind === 'malformed') {
      return `_[The model's tool call kept coming out malformed, so it didn't run. Ollama said: ${detail}. Try again, or try another model.]_`;
    }
    if (kind === 'withheld') return "_[The model's tool call kept getting lost on the way, so it didn't run. Try again, or try another model.]_";
    if (kind === 'empty') return '_[The model stopped without a reply, even when asked to carry on. Send "continue" to let it try again.]_';
    return '_[The model said it would use a tool, but didn\'t make the tool call, even when asked again. Send "continue" to let it try once more.]_';
  }

  return { MAX_NUDGES, localSampling, missedToolCall, nudgeFor, retryLabel, giveUpNote };
});
