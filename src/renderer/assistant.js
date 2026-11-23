
const bridge = window.frostbyte;
const byId = id => document.getElementById(id);
const panel = byId('assistant-panel');
const toggle = byId('assistant-toggle');
const select = byId('assistant-model-select');
const messages = byId('assistant-messages');
const input = byId('assistant-input');
const send = byId('assistant-send');
const stop = byId('assistant-stop');
const error = byId('assistant-error');
const stateLabel = byId('assistant-model-state');
let catalog = null;
let current = null;
let generating = false;
let activeText = null;
let activeReasoning = null;
let activeReasoningText = '';
let activeStream = null;
let unsubscribe = () => {};
let generation = 0;
let transitioning = false;
let activeConversation = null;
function setTransitioning(value) { transitioning = value; send.disabled = value || generating || !select.value; }

function showError(text = '') { error.textContent = text; error.hidden = !text; }
function setGenerating(value) {
  generating = value;
  send.disabled = value; send.hidden = value;
  stop.hidden = !value; select.disabled = value;
  input.disabled = value;
  byId('assistant-clear').disabled = value;
}
function appendMessage(role, content, label = null) {
  const empty = messages.querySelector('.assistant-empty'); if (empty) empty.remove();
  const article = document.createElement('article'); article.className = `assistant-message ${role}`;
  const heading = document.createElement('div'); heading.className = 'assistant-message-role'; heading.textContent = role === 'user' ? 'You' : label || select.selectedOptions[0]?.textContent?.split(' · ')[0] || 'Assistant';
  const text = document.createElement('div'); text.className = 'assistant-message-content'; text.textContent = content;
  article.append(heading, text); messages.append(article); messages.scrollTop = messages.scrollHeight;
  return text;
}
function attachReasoning(textNode) {
  const details = document.createElement('details'); details.className = 'assistant-reasoning';
  const summary = document.createElement('summary'); summary.textContent = 'Thinking…';
  const body = document.createElement('div'); body.className = 'assistant-reasoning-text';
  details.append(summary, body); textNode.parentNode.insertBefore(details, textNode);
  activeReasoningText = '';
  activeReasoning = { details, summary, body };
  return activeReasoning;
}
async function loadHistory(id, { force = false } = {}) {
  if ((generating || transitioning) && !force) return;
  const epoch = ++generation;
  setTransitioning(true);
  let record;
  try { record = await bridge.runtimeHistory(id); }
  finally { setTransitioning(false); }
  if (epoch !== generation) return;
  current = record;
  messages.replaceChildren();
  // History keeps its own model label: the currently selected model may differ.
  for (const message of current.messages) appendMessage(message.role, message.content, message.role === 'assistant' ? (current.model || 'Assistant') : null);
  if (!current.messages.length) { messages.replaceChildren(); const empty = document.createElement('p'); empty.className = 'assistant-empty'; empty.textContent = 'Start a conversation with a model on one of your devices.'; messages.append(empty); }
  renderHistory();
}
async function renderHistory() {
  const list = byId('assistant-history'); const rows = await bridge.runtimeConversations(); list.replaceChildren();
  for (const row of rows) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `assistant-history-item${current?.id === row.id ? ' active' : ''}`;
    button.textContent = row.preview;
    const time = document.createElement('time'); time.textContent = new Date(row.updated).toLocaleDateString(); button.append(time);
    button.addEventListener('click', () => loadHistory(row.id).catch(() => showError('Could not load this conversation.')));
    list.append(button);
  }
}
async function createConversation({ force = false } = {}) {
  if ((generating || transitioning) && !force) return;
  const epoch = ++generation;
  setTransitioning(true);
  let conversation;
  try { conversation = await bridge.runtimeNew(); }
  finally { setTransitioning(false); }
  if (epoch !== generation) return;
  await loadHistory(conversation.id, { force: true });
}
const PROVIDER_LABELS = { ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang', 'frostbyte-llama': 'FrostByte runtime' };
async function discover(refresh = false) {
  stateLabel.textContent = 'Looking for runtimes on this computer and paired devices…'; select.disabled = true;
  try {
    catalog = await bridge.runtimeModels(refresh);
    select.replaceChildren();
    let total = 0;
    for (const device of catalog.devices) {
      if (!device.models.length) continue;
      const group = document.createElement('optgroup'); group.label = device.name;
      for (const model of device.models) {
        const option = document.createElement('option'); option.value = model.id; option.textContent = `${model.name} · ${model.state === 'ready' ? 'Running' : 'Available'} · ${PROVIDER_LABELS[model.provider] || model.provider}`;
        group.append(option); total++;
      }
      select.append(group);
    }
    if (!total) { const option = document.createElement('option'); option.textContent = 'No chat models found'; option.disabled = true; select.append(option); }
    stateLabel.textContent = total ? `${total} model${total === 1 ? '' : 's'} · auto-discovered, no endpoints needed` : 'Add a model to your library, or start Ollama, LM Studio, llama.cpp, vLLM or SGLang, then refresh. Paired devices may need a companion update.';
    send.disabled = !total || generating;
  } catch { showError('Model discovery is unavailable. You can retry without changing endpoint settings.'); }
  select.disabled = generating;
}
async function sendMessage() {
  if (generating || transitioning) return;
  showError();
  const content = input.value.trim();
  if (!content) return;
  if (!select.value) { showError('Choose a model first.'); return; }
  if (!current) {
    const epoch = generation;
    setTransitioning(true);
    try { current = await bridge.runtimeNew(); } finally { setTransitioning(false); }
    if (epoch !== generation) return;
  }
  const conversation = current;
  activeConversation = conversation.id;
  const chosen = catalog.devices.flatMap(device => device.models).find(model => model.id === select.value);
  if (chosen?.provider === 'frostbyte-llama' && chosen.state !== 'ready') stateLabel.textContent = 'Loading this model into the FrostByte runtime… first load can take a minute.';
  setGenerating(true); input.value = ''; appendMessage('user', content);
  const textNode = appendMessage('assistant', ''); activeText = textNode; activeReasoning = null;
  try { await bridge.chatStream({ conversationId: conversation.id, modelId: select.value, content }); }
  catch (err) { if (textNode.isConnected && !textNode.textContent) textNode.textContent = 'Chat stopped.'; if (!String(err?.message).includes('cancelled')) showError('The model could not complete this request. Check that its runtime is still running.'); }
  finally {
    if (textNode.isConnected && !textNode.textContent) textNode.textContent = activeReasoning ? 'The model finished with a thought process only — expand it above.' : 'The model returned an empty response.';
    if (activeReasoning) activeReasoning.summary.textContent = 'Thought process';
    setGenerating(false); if (activeText === textNode) { activeStream = null; activeText = null; activeReasoning = null; activeConversation = null; } stateLabel.textContent = 'Ready · models stay auto-discovered'; await renderHistory().catch(() => {});
  }
}
function handleEvent(event) {
  // Bind every frame to the exact conversation + job this send started; a stale
  // completion can never finish a newer message after a history switch.
  if (!event || !current || event.conversationId !== current.id || event.conversationId !== activeConversation) return;
  if (event.type === 'delta' && activeText && event.stream === activeStream) {
    if (activeReasoning) activeReasoning.summary.textContent = 'Thought process';
    activeText.textContent += event.text; messages.scrollTop = messages.scrollHeight;
  }
  if (event.type === 'reasoning' && activeText && event.stream === activeStream) {
    const block = activeReasoning || attachReasoning(activeText);
    activeReasoningText += event.text;
    if (activeReasoningText.length > 16384) activeReasoningText = activeReasoningText.slice(-16384);
    block.body.textContent = activeReasoningText;
    if (block.details.open) messages.scrollTop = messages.scrollHeight;
  }
  if (event.type === 'start') { activeStream = event.stream; }
  if (event.type === 'capped' && activeText && event.stream === activeStream) {
    activeText.textContent += '\n\n[Response stopped: history limit reached.]';
    stateLabel.textContent = 'Response stopped at the history limit';
  }
  if (event.type === 'error') showError('The model could not complete the request.');
}
async function close() { if (generating && current) await bridge.chatCancel(current.id).catch(() => {}); panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
export function initAssistant() {
  if (!bridge?.runtimeModels) return;
  toggle.addEventListener('click', () => {
    if (!panel.hidden) return close();
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    Promise.all([discover(), bridge.runtimeConversations().then(rows => rows.length ? loadHistory(rows[0].id) : createConversation())]).catch(() => showError('The assistant could not start.'));
    unsubscribe(); unsubscribe = bridge.onRuntimeEvent(handleEvent);
    input.focus();
  });
  byId('assistant-close').addEventListener('click', close);
  byId('assistant-refresh').addEventListener('click', () => discover(true));
  byId('assistant-new').addEventListener('click', () => createConversation().catch(() => showError('Could not create a conversation.')));
  byId('assistant-clear').addEventListener('click', async () => {
    if (generating || !window.confirm('Clear all local assistant conversations on this computer? This cannot be undone.')) return;
    await bridge.runtimeClear(); current = null; messages.replaceChildren(); await createConversation({ force: true });
  });
  send.addEventListener('click', () => sendMessage().catch(() => { setGenerating(false); showError('Could not send this message.'); }));
  stop.addEventListener('click', () => { if (current) bridge.chatCancel(current.id).catch(() => {}); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send.click(); } });
}
