const $ = id => document.getElementById(id);
let stream = null, live = null, active = false, starting = false, stopping = false;
let captureEpoch = 0, detectionVersion = 0, detectionTimer = null, detectionCandidate = null, analyzing = false;
let generation = 0, answering = false;
let apiState = {configured: false, storage: 'none'}, settingsBusy = false;
let selectedQuestion = null, manualSerial = 0;
const transcriptItems = new Map();
const analyzedText = new Map();
const detectedQuestions = new Map();
let questionSerial = 0;
const answeredIds = new Set();
const conversationRequests = new Set();
const report = message => { $('error').textContent = message; $('error').hidden = !message; };
const status = message => { $('status').textContent = message; };

function showApiState(config) {
  apiState = config;
  const descriptions = {session: 'Session only', protected: 'Saved in Windows', environment: 'From .env / environment', none: 'No API key'};
  $('api-status').textContent = descriptions[config.storage] || (config.configured ? 'API configured' : 'No API key');
  $('api-status').className = 'api-badge ' + (config.configured ? 'ready' : 'missing');
  $('remember-key').checked = config.storage === 'protected';
  $('clear-key').textContent = config.storage === 'protected' ? 'Remove saved key' : 'Remove key';
  $('clear-key').disabled = settingsBusy || !['session', 'protected'].includes(config.storage);
  $('api-key').placeholder = config.configured ? 'Paste a new key to replace it' : 'Paste your API key here';
  if (!config.configured) $('settings').open = true;
  updateAnswerButton();
}

function requireKey() {
  if (apiState.configured) return true;
  $('settings').open = true;
  $('api-key').focus();
  report('Enter your OpenAI key in API settings and click Apply key.');
  return false;
}

function isChromeBrowser() {
  const userAgent = navigator.userAgent || '';
  if (/(Edg|Edge|OPR|Opera|SamsungBrowser)\//.test(userAgent) || navigator.brave) return false;
  const brands = navigator.userAgentData?.brands;
  if (brands?.length) return brands.some(({brand}) => brand === 'Google Chrome');
  return /Chrome\//.test(userAgent) && navigator.vendor === 'Google Inc.';
}

async function changeKey(body) {
  if (settingsBusy) return;
  settingsBusy = true; $('save-key').disabled = true; $('clear-key').disabled = true;
  $('key-message').textContent = 'Applying…'; report('');
  try {
    const config = await request('/api/settings', body);
    showApiState(config);
    $('api-key').value = ''; $('api-key').type = 'password';
    $('toggle-key').textContent = 'Show'; $('toggle-key').setAttribute('aria-pressed', 'false');
    $('key-message').textContent = body.clear
      ? (config.configured ? 'App key removed. Using the environment or .env key.' : 'API key removed from this app and device.')
      : (config.storage === 'protected' ? 'API key encrypted and saved in Windows. Ready to use.' : 'API key applied for this session. Ready to use.');
  } catch (error) {
    $('key-message').textContent = 'Could not apply the change. Try again.';
    report(error.message);
  } finally {
    settingsBusy = false; $('save-key').disabled = false;
    $('clear-key').disabled = !['session', 'protected'].includes(apiState.storage);
  }
}

$('key-form').onsubmit = event => {
  event.preventDefault();
  void changeKey({api_key: $('api-key').value.trim(), remember: $('remember-key').checked});
};
$('clear-key').onclick = () => void changeKey({clear: true});
$('toggle-key').onclick = () => {
  const visible = $('api-key').type === 'password';
  $('api-key').type = visible ? 'text' : 'password';
  $('toggle-key').textContent = visible ? 'Hide' : 'Show';
  $('toggle-key').setAttribute('aria-pressed', String(visible));
};

async function request(path, body, isAudio = false) {
  const controller = new AbortController();
  if (path !== '/api/settings') conversationRequests.add(controller);
  try {
    const response = await fetch(path, {
      method: 'POST', headers: {'Content-Type': isAudio ? 'audio/wav' : 'application/json'},
      body: isAudio ? body : JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(100000)])
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not process the request.');
    return result;
  } finally { conversationRequests.delete(controller); }
}

function updateStatus() {
  status(starting ? 'Connecting…' : stopping ? 'Stopping audio…' : answering
    ? 'Generating answer…' : active ? 'Live transcript' : 'Ready');
}

function updateAnswerButton() {
  const answered = selectedQuestion && answeredIds.has(selectedQuestion.id);
  $('answer').disabled = !apiState.configured || !selectedQuestion || !selectedQuestion.confirmed || answering || answered;
  $('answer').textContent = answering ? 'Generating answer…' : 'Generate answer ↗';
  $('question-state').textContent = !selectedQuestion
    ? (analyzing ? 'Analyzing context…' : 'Waiting for questions')
    : answered ? 'Answered' : !selectedQuestion.confirmed ? 'Checking context…' : 'Question ready';
  $('question-state').className = selectedQuestion && !answered ? 'ready' : '';
}

function questionKey(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function selectQuestion(id) {
  const item = detectedQuestions.get(id);
  if (!item) return;
  selectedQuestion = {id: item.id, text: item.text, confirmed: item.confirmed};
  $('question').value = item.text;
  renderQuestionList(); updateAnswerButton();
}

function renderQuestionList() {
  if ($('questions-list').querySelector('.empty')) $('questions-list').replaceChildren();
  let number = 0;
  for (const item of detectedQuestions.values()) {
    if (!item.node) {
      item.node = document.createElement('button'); item.node.type = 'button';
      item.node.setAttribute('role', 'listitem');
      item.node.onclick = () => { answeredIds.delete(item.id); selectQuestion(item.id); };
    }
    const state = answeredIds.has(item.id) ? 'Answered' : item.confirmed ? 'Confirmed' : 'Under review';
    item.node.textContent = (++number) + '. ' + item.text + ' · ' + state;
    item.node.className = 'question-option' + (selectedQuestion?.id === item.id ? ' selected' : '');
    item.node.setAttribute('aria-pressed', String(selectedQuestion?.id === item.id));
    $('questions-list').append(item.node);
  }
  $('question-count').textContent = String(detectedQuestions.size);
}

function collectQuestions(texts, sourceIds, confirmed) {
  const previous = [...detectedQuestions.values()].filter(q => q.sourceIds.some(id => sourceIds.includes(id)));
  const used = new Set();
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index].trim();
    if (!text) continue;
    let item = previous.find(q => !used.has(q.id) && questionKey(q.text) === questionKey(text));
    if (!item && confirmed && previous.length === texts.length && !used.has(previous[index]?.id)) item = previous[index];
    if (!item) {
      item = {id: 'q-' + (++questionSerial), text, sourceIds: [...sourceIds], confirmed};
      detectedQuestions.set(item.id, item);
    } else if (confirmed || !item.confirmed) {
      item.text = text; item.confirmed = confirmed || item.confirmed;
      item.sourceIds = [...new Set([...item.sourceIds, ...sourceIds])];
    }
    used.add(item.id);
    if (selectedQuestion?.id === item.id) selectedQuestion = {id: item.id, text: item.text, confirmed: item.confirmed};
    if (!selectedQuestion) selectedQuestion = {id: item.id, text: item.text, confirmed: item.confirmed};
  }
  if (confirmed) {
    for (const item of previous) {
      if (!item.confirmed && !used.has(item.id)) {
        item.node?.remove(); detectedQuestions.delete(item.id);
        if (selectedQuestion?.id === item.id) selectedQuestion = null;
      }
    }
    if (!selectedQuestion) {
      const pending = [...detectedQuestions.values()].find(item => !answeredIds.has(item.id));
      if (pending) selectedQuestion = {id: pending.id, text: pending.text, confirmed: pending.confirmed};
    }
  }
  $('question').value = selectedQuestion?.text || '';
  renderQuestionList(); updateAnswerButton();
}

function detectLiteralQuestions(item) {
  const questions = item.text.includes('[unclear]') ? [] : item.text.match(/[^.!?\n]+\?/g) || [];
  const keys = questions.map(questionKey);
  for (const old of detectedQuestions.values()) {
    if (!old.confirmed && old.sourceIds.length === 1 && old.sourceIds[0] === item.id && !keys.includes(questionKey(old.text))) {
      old.node?.remove(); detectedQuestions.delete(old.id);
      if (selectedQuestion?.id === old.id) selectedQuestion = null;
    }
  }
  collectQuestions(questions, [item.id], false);
}

function orderedItems() {
  const ordered = [], visited = new Set(), visiting = new Set();
  function visit(item) {
    if (visited.has(item.id) || visiting.has(item.id)) return;
    visiting.add(item.id);
    const previous = transcriptItems.get(item.previousId);
    if (previous) visit(previous);
    visiting.delete(item.id); visited.add(item.id); ordered.push(item);
  }
  for (const item of transcriptItems.values()) visit(item);
  return ordered;
}

function contextText(excludeId = null) {
  return orderedItems().filter(item => item.id !== excludeId
    && !(excludeId instanceof Set && excludeId.has(item.id)) && item.text.trim())
    .map(item => item.text.trim()).join('\n').slice(-100000);
}

function renderTranscript() {
  if ($('transcript').querySelector('.empty')) $('transcript').replaceChildren();
  const ordered = orderedItems();
  const visible = ordered.slice(-80);
  for (const [index, item] of visible.entries()) {
    if (!item.node) {
      item.node = document.createElement('p');
      item.node.className = 'transcript-line';
    }
    if (item.node.textContent !== item.text) item.node.textContent = item.text;
    item.node.className = 'transcript-line' + (item.final ? '' : ' partial');
    if ($('transcript').children[index] !== item.node) {
      if ($('transcript').insertBefore) $('transcript').insertBefore(item.node, $('transcript').children[index] || null);
      else $('transcript').append(item.node);
    }
  }
  while ($('transcript').children.length > 80) $('transcript').firstChild.remove();
  $('transcript').scrollTop = $('transcript').scrollHeight;
  $('context-count').textContent = ordered.filter(item => item.text.trim()).length + ' turns in context';
}

function updateTranscript(id, text, final = false) {
  text = sanitizeEnglishTranscript(text);
  let item = transcriptItems.get(id);
  if (!item) { item = {id, text: '', final: false, previousId: null}; transcriptItems.set(id, item); }
  if (item.final && !final) return;
  if (item.text === text && item.final === final) return;
  item.text = text; item.final = final;
  detectLiteralQuestions(item);
  renderTranscript();
  if (text.includes('[unclear]')) $('latency').textContent = 'Unclear words marked';
  if (text.trim() && !text.includes('[unclear]')) scheduleDetection(item, final ? 0 : 150);
}

function orderTranscript(id, previousId) {
  const item = transcriptItems.get(id) || {id, text: '', final: false};
  item.previousId = previousId; transcriptItems.set(id, item);
  renderTranscript();
}

function scheduleDetection(item, delay) {
  detectionVersion++;
  detectionCandidate = {id: item.id, text: item.text, version: detectionVersion};
  if (detectionTimer) {
    if (delay !== 0) return;
    clearTimeout(detectionTimer);
  }
  detectionTimer = setTimeout(() => { detectionTimer = null; void runDetection(); }, delay);
}

async function runDetection() {
  if (analyzing || !detectionCandidate) return;
  const candidate = detectionCandidate, epoch = generation;
  detectionCandidate = null;
  const updates = orderedItems().filter(item => item.text.trim() && !item.text.includes('[unclear]')
    && analyzedText.get(item.id) !== item.text)
    .map(item => ({id: item.id, text: item.text}));
  if (!updates.length) return;
  analyzing = true; updateAnswerButton();
  try {
    const result = await request('/api/analyze', {
      text: updates.map(item => item.text).join('\n').slice(-16000),
      history: contextText(new Set(updates.map(item => item.id)))
    });
    if (epoch !== generation) return;
    if (updates.some(item => transcriptItems.get(item.id)?.text !== item.text)) return;
    for (const item of updates) analyzedText.set(item.id, item.text);
    const questions = Array.isArray(result.questions) ? result.questions
      : result.is_question && result.question?.trim() ? [result.question] : [];
    collectQuestions(questions, updates.map(item => item.id), true);
  } catch (error) { if (epoch === generation) report(error.message); }
  finally {
    if (epoch === generation) {
      analyzing = false; updateAnswerButton();
      if (detectionCandidate && !detectionTimer) {
        detectionTimer = setTimeout(() => { detectionTimer = null; void runDetection(); }, 0);
      }
    }
  }
}

async function stop(drain = true) {
  const epoch = ++captureEpoch, connection = live, captured = stream;
  stopping = true; active = false; starting = false;
  $('start').disabled = true; $('stop').disabled = true; updateStatus();
  if (!drain) live = null;
  try { if (connection) await connection.stop({drain}); }
  finally {
    captured?.getTracks().forEach(track => track.stop());
    if (epoch === captureEpoch) {
      live = null; stream = null; stopping = false;
      $('level').style.width = '0'; $('start').disabled = false; updateStatus();
    }
  }
}

$('start').onclick = async () => {
  if (!isChromeBrowser()) { report('Open run.bat to use this app in Google Chrome.'); return; }
  if (starting || active || stopping || !requireKey()) return;
  const epoch = ++captureEpoch;
  starting = true; $('start').disabled = true; report(''); updateStatus();
  let captured;
  try {
    // Request capture directly from the user click.
    captured = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false},
      preferCurrentTab: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
    });
    if (epoch !== captureEpoch) { captured.getTracks().forEach(t => t.stop()); return; }
    stream = captured; $('stop').disabled = false;
    if (!captured.getAudioTracks().length) throw new Error('Select the Meet tab and enable Share tab audio.');
    const token = await request('/api/realtime-token', {});
    if (epoch !== captureEpoch) return;
    const connection = new LiveTranscription({
      getThreshold: () => Number($('threshold').value),
      onPartial: (id, text) => { if (live === connection) updateTranscript(id, text, false); },
      onFinal: (id, text) => { if (live === connection) updateTranscript(id, text, true); },
      onOrder: (id, previousId) => { if (live === connection) orderTranscript(id, previousId); },
      onLevel: rms => { if (live === connection) $('level').style.width = Math.min(100, rms * 550) + '%'; },
      onLatency: ms => { if (live === connection) $('latency').textContent = 'First partial: ' + Math.round(ms) + ' ms'; },
      onError: message => { if (live === connection) { report(message); void stop(false); } }
    });
    live = connection;
    await connection.connect(captured, token);
    if (epoch !== captureEpoch) return;
    active = true; $('latency').textContent = 'Waiting for speech';
    captured.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (live === connection && !stopping) void stop();
    }));
  } catch (error) {
    if (epoch === captureEpoch) {
      report(error.name === 'NotAllowedError' ? 'Capture canceled or permission denied.'
        : typeof DOMException !== 'undefined' && error instanceof DOMException
          ? 'Could not start capture. Check browser permissions and audio selection.' : error.message);
      await stop(false);
    }
  } finally {
    if (epoch === captureEpoch) {
      starting = false; $('start').disabled = active || stopping; updateStatus();
    }
  }
};
$('stop').onclick = () => void stop();

$('answer').onclick = async () => {
  if (answering || !selectedQuestion?.confirmed || answeredIds.has(selectedQuestion.id) || !requireKey()) return;
  const question = {...selectedQuestion}, epoch = generation;
  answering = true; report(''); updateAnswerButton(); updateStatus();
  $('response').textContent = 'Generating an answer…'; $('copy').disabled = true;
  $('answered-question').textContent = question.text; $('answered-question').hidden = false;
  try {
    const result = await request('/api/answer', {
      question: question.text, context: $('context').value, history: contextText()
    });
    if (epoch !== generation) return;
    if (!result.answer?.trim() || result.answer.trim() === '[NO_REPLY]') {
      throw new Error('No answer was generated. Check the selected question.');
    }
    $('response').textContent = result.answer; $('copy').disabled = false;
    answeredIds.add(question.id);
    renderQuestionList();
  } catch (error) {
    if (epoch === generation) { report(error.message); $('response').textContent = 'Could not generate an answer. Please try again.'; }
  } finally {
    if (epoch === generation) { answering = false; updateAnswerButton(); updateStatus(); }
  }
};
$('analyze-manual').onclick = () => {
  if (!requireKey()) return;
  const text = $('manual-text').value.trim();
  if (!text) { report('Enter some context or a question.'); return; }
  report(''); updateTranscript('manual-' + (++manualSerial), text, true);
  $('manual-text').value = '';
};
$('clear').onclick = () => {
  generation++;
  if (detectionTimer) clearTimeout(detectionTimer);
  detectionTimer = null; detectionCandidate = null; analyzing = false;
  for (const controller of conversationRequests) controller.abort();
  conversationRequests.clear();
  // Stop the stream so late events from a previous conversation cannot repopulate it.
  void stop(false);
  answering = false; selectedQuestion = null; answeredIds.clear(); transcriptItems.clear(); analyzedText.clear();
  detectedQuestions.clear(); questionSerial = 0; $('questions-list').replaceChildren(); $('question-count').textContent = '0';
  $('transcript').replaceChildren(); $('question').value = '';
  $('context-count').textContent = '0 turns in context'; $('latency').textContent = 'Waiting for audio';
  $('response').textContent = 'When a question is detected, click to generate an answer.';
  $('answered-question').textContent = ''; $('answered-question').hidden = true;
  $('copy').disabled = true; report(''); updateAnswerButton();
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('response').textContent); }
  catch { report('Could not copy. Select the text and press Ctrl+C.'); }
};
window.addEventListener('beforeunload', () => {
  live?.stop({drain: false}); stream?.getTracks().forEach(track => track.stop());
});
fetch('/api/status').then(async response => {
  if (!response.ok) throw new Error('Could not check the API settings.');
  showApiState(await response.json());
}).catch(error => report(error.message || 'Could not connect to the local server.'));
