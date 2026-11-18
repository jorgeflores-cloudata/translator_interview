const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  return {promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value)};
}

function fixture() {
  const nodes = new Map(), calls = [], timers = new Map(), lives = [];
  let timerId = 0, tracksStopped = 0;
  function node(id = '') {
    return {id, value: '', disabled: false, hidden: false, children: [], parent: null, style: {},
      textContent: '', className: '', classList: {add() {}}, attributes: {},
      append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } },
      insertBefore(child, before) { child.remove(); child.parent = this; const index = this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); },
      replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); },
      remove() { if (this.parent) { const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); this.parent = null; } },
      querySelector() { return null; }, setAttribute(name, value) { this.attributes[name] = value; }, focus() {},
      get firstChild() { return this.children[0]; }};
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); };
  const control = {
    analysis: {is_question: false, question: '', questions: []},
    answer: {answer: 'I start by clarifying the requirements.'}, analysisGate: null, answerGate: null,
  };
  const track = {stop() { tracksStopped++; }, addEventListener() {}};
  const captured = {getTracks: () => [track], getAudioTracks: () => [track]};
  class FakeLive {
    constructor(options) { this.options = options; this.stops = []; lives.push(this); }
    async connect(stream, token) { this.stream = stream; this.token = token; }
    async stop(options) { this.stops.push(options); }
  }
  const context = vm.createContext({
    document: {getElementById: get, createElement: () => node()},
    navigator: {userAgent: 'Chrome/130.0', vendor: 'Google Inc.', mediaDevices: {getDisplayMedia: async () => captured}},
    LiveTranscription: FakeLive, window: {addEventListener() {}}, AbortController, console,
    AbortSignal: {
      any: signals => AbortSignal.any(signals),
      timeout: () => new AbortController().signal,
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      if (url === '/api/status') return {ok: true, json: async () => ({configured: true, storage: 'session'})};
      calls.push({url, body: JSON.parse(options.body), signal: options.signal});
      let result;
      if (url === '/api/realtime-token') result = {value: 'ek_fake', model: 'gpt-live-transcribe'};
      else if (url === '/api/analyze') result = control.analysisGate ? await control.analysisGate.promise : control.analysis;
      else result = control.answerGate ? await control.answerGate.promise : control.answer;
      return {ok: !result.error, json: async () => result};
    },
  });
  const realtimeSource = fs.readFileSync(path.join(__dirname, '../app/realtime.js'), 'utf8');
  vm.runInContext(realtimeSource.slice(0, realtimeSource.indexOf('class LiveTranscription')), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  const detect = async () => run('if (detectionTimer) clearTimeout(detectionTimer); detectionTimer = null; runDetection()');
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {get, calls, control, timers, lives, run, detect, settle, get tracksStopped() { return tracksStopped; }};
}

async function runTests() {
  let count = 0;
  const fresh = async () => { const f = fixture(); await f.settle(); return f; };
  const question = {is_question: true, question: 'How do you work?', questions: ['How do you work?']};
  {
    const f = await fresh(); f.control.analysis = question;
    f.run("updateTranscript('a', 'How do you work?', true); updateTranscript('b', 'Take your time.', true)");
    await f.detect();
    assert.match(f.calls[0].body.text, /How do you work\?/);
    assert.match(f.calls[0].body.text, /Take your time/);
    assert.equal(f.get('answer').disabled, false); count++;
  }
  {
    const f = await fresh();
    assert.equal(f.get('answer').disabled, true);
    f.run("updateTranscript('a', 'This is a statement.', true)"); await f.detect();
    assert.equal(f.get('answer').disabled, true);
    assert.deepEqual(f.calls.map(c => c.url), ['/api/analyze']);
    assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['history', 'text']); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'How do', false)");
    assert.equal(f.get('transcript').children[0].textContent, 'How do');
    assert.match(f.get('transcript').children[0].className, /partial/);
    assert.equal(f.calls.length, 0);
    assert.equal([...f.timers.values()][0].delay, 150);
    f.run("updateTranscript('a', 'How do you work?', true)");
    assert.equal(f.get('transcript').children.length, 1);
    assert.equal(f.run('contextText()'), 'How do you work?');
    assert.equal(f.get('transcript').children[0].className, 'transcript-line');
    f.run("updateTranscript('a', 'late partial', false)");
    assert.equal(f.run('contextText()'), 'How do you work?'); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'We chose PostgreSQL to enforce transactional consistency.', true)"); await f.detect();
    f.control.analysis = {is_question: true, question: 'Why did you choose PostgreSQL for transactional consistency?'};
    f.run("updateTranscript('b', 'Why?', true)"); await f.detect();
    const call = f.calls.at(-1);
    assert.equal(call.body.text, 'Why?');
    assert.match(call.body.history, /PostgreSQL/);
    assert.doesNotMatch(call.body.history, /Why\?/);
    assert.equal(f.get('question').value, f.control.analysis.question);
    assert.equal(f.get('answer').disabled, false); count++;
  }
  {
    const f = await fresh();
    for (let i = 0; i < 110; i++) f.run(`updateTranscript('turn-${i}', ${JSON.stringify('turn-' + i + ': ' + 'x'.repeat(1000))}, true)`);
    assert.equal(f.run('transcriptItems.size'), 110);
    assert.equal(f.get('transcript').children.length, 80);
    assert.equal(f.run('contextText().length'), 100000);
    assert.match(f.run('contextText()'), /turn-109:/);
    assert.equal(f.get('context-count').textContent, '110 turns in context'); count++;
  }
  {
    const f = await fresh(); f.control.analysis = question;
    f.run("updateTranscript('a', 'How do you work?', true)"); await f.detect();
    assert.equal(f.calls.some(c => c.url === '/api/answer'), false);
    f.run("updateTranscript('b', 'Our team uses continuous delivery.', true)");
    await f.get('answer').onclick();
    assert.equal(f.calls.at(-1).url, '/api/answer');
    assert.match(f.calls.at(-1).body.history, /continuous delivery/);
    assert.equal(f.calls.at(-1).body.question, question.question);
    assert.equal(f.get('response').textContent, f.control.answer.answer);
    assert.equal(f.get('answer').disabled, true); count++;
  }
  {
    const f = await fresh(); f.control.analysis = question;
    f.run("updateTranscript('a', 'How do you work?', true)"); await f.detect();
    const gate = deferred(); f.control.answerGate = gate;
    const answering = f.get('answer').onclick();
    f.control.analysis = {is_question: true, question: 'What tools do you use?'};
    f.run("updateTranscript('b', 'What tools do you use?', true)"); await f.detect();
    assert.equal(f.get('question').value, question.question);
    f.run("selectQuestion([...detectedQuestions.values()].find(q => q.text === 'What tools do you use?').id)");
    gate.resolve({answer: 'I clarify requirements.'}); await answering;
    assert.equal(f.get('question').value, 'What tools do you use?');
    assert.equal(f.get('answered-question').textContent, question.question);
    assert.equal(f.get('answer').disabled, false); count++;
  }
  {
    const f = await fresh(); await f.get('start').onclick();
    assert.deepEqual(f.calls.map(c => c.url), ['/api/realtime-token']);
    f.lives[0].options.onPartial('a', 'Live words');
    assert.equal(f.get('transcript').children[0].textContent, 'Live words');
    f.lives[0].options.onFinal('a', 'Live words completed.');
    const gate = deferred(); f.control.analysisGate = gate;
    const analyzing = f.detect();
    f.get('clear').onclick(); await f.settle();
    assert.equal(f.lives[0].stops[0].drain, false);
    assert.ok(f.tracksStopped > 0);
    assert.equal(f.calls.find(c => c.url === '/api/analyze').signal.aborted, true);
    gate.resolve(question); await analyzing;
    f.lives[0].options.onFinal('stale', 'Stale words');
    assert.equal(f.get('transcript').children.length, 0);
    assert.equal(f.get('answer').disabled, true);
    assert.equal(f.get('question').value, ''); count++;
  }
  {
    const f = await fresh();
    f.run("orderTranscript('b', 'a'); updateTranscript('b', 'Second.', true)");
    f.run("orderTranscript('a', null); updateTranscript('a', 'First.', true)");
    assert.equal(f.run('contextText()'), 'First.\nSecond.');
    assert.deepEqual(f.get('transcript').children.map(n => n.textContent), ['First.', 'Second.']); count++;
  }
  {
    const f = await fresh(); f.control.analysis = question;
    f.run("updateTranscript('a', 'How do you work?', true)"); await f.detect();
    f.control.analysis = {is_question: false, question: ''};
    f.run("updateTranscript('b', 'We have time.', true)"); await f.detect();
    assert.equal(f.get('question').value, question.question);
    assert.equal(f.get('answer').disabled, false); count++;
  }
  {
    const f = await fresh(); f.control.analysis = question;
    f.run("updateTranscript('a', 'How do you work?', true)"); await f.detect();
    f.control.answer = {error: 'Try again'}; await f.get('answer').onclick();
    assert.equal(f.get('answer').disabled, false);
    assert.equal(f.get('copy').disabled, true); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'Do you use Java?', false)");
    const gate = deferred(); f.control.analysisGate = gate;
    const analyzing = f.detect();
    f.run("updateTranscript('a', 'Do you use JavaScript?', true)");
    gate.resolve({is_question: true, question: 'Do you use Java?'}); await analyzing;
    assert.equal(f.get('answer').disabled, true);
    assert.equal(f.get('question').value, 'Do you use JavaScript?');
    f.control.analysisGate = null;
    f.control.analysis = {is_question: true, question: 'Do you use JavaScript?'};
    await f.detect();
    assert.equal(f.get('answer').disabled, false);
    assert.equal(f.get('question').value, 'Do you use JavaScript?'); count++;
  }
  {
    const f = await fresh();
    const questions = ['Do I count the dog and the cat?', 'Do you have any siblings?', 'How old is your sibling?'];
    f.run(`updateTranscript('family', ${JSON.stringify(questions.join('\n'))}, true)`);
    assert.equal(f.run('detectedQuestions.size'), 3);
    assert.equal(f.get('questions-list').children.length, 3);
    assert.match(f.get('questions-list').children[0].textContent, /^1\. Do I count/);
    assert.match(f.get('questions-list').children[1].textContent, /^2\. Do you have/);
    assert.match(f.get('questions-list').children[2].textContent, /^3\. How old/);
    assert.equal(f.get('answer').disabled, true);
    f.control.analysis = {is_question: true, question: questions[0], questions};
    await f.detect();
    assert.equal(f.run('detectedQuestions.size'), 3);
    assert.equal(f.get('questions-list').children.length, 3);
    assert.equal(f.get('question-count').textContent, '3');
    assert.equal(f.get('answer').disabled, false);
    f.get('questions-list').children[1].onclick();
    assert.equal(f.get('question').value, questions[1]);
    f.run("updateTranscript('context', 'We are discussing family members.', true)");
    await f.get('answer').onclick();
    const answer = f.calls.find(call => call.url === '/api/answer');
    assert.equal(answer.body.question, questions[1]);
    assert.match(answer.body.history, /discussing family/);
    assert.match(f.get('questions-list').children[1].textContent, /Answered/);
    assert.equal(f.get('answer').disabled, true); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'Do you have siblings?', false)");
    assert.equal(f.get('answer').disabled, true);
    assert.match(f.get('questions-list').children[0].textContent, /Under review/);
    f.run("updateTranscript('a', 'I have a brother.', true)");
    assert.equal(f.run('detectedQuestions.size'), 0);
    assert.equal(f.get('questions-list').children.length, 0);
    assert.equal(f.get('question').value, ''); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'Is this a rhetorical example?', true)");
    assert.equal(f.run('detectedQuestions.size'), 1);
    f.control.analysis = {is_question: false, question: '', questions: []};
    await f.detect();
    assert.equal(f.run('detectedQuestions.size'), 0);
    assert.equal(f.get('questions-list').children.length, 0);
    assert.equal(f.get('question').value, '');
    assert.equal(f.get('answer').disabled, true); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'Do you have siblings?', true)");
    f.control.analysis = {is_question: true, question: 'Do you have siblings?', questions: ['Do you have siblings?']};
    await f.detect();
    f.run("updateTranscript('b', 'How old is your sibling?', true)");
    f.control.analysis = {is_question: true, question: 'How old is your sibling?', questions: ['How old is your sibling?']};
    await f.detect();
    assert.equal(f.run('detectedQuestions.size'), 2);
    assert.equal(f.get('question').value, 'Do you have siblings?');
    assert.match(f.get('questions-list').children[0].textContent, /Do you have siblings/);
    assert.match(f.get('questions-list').children[1].textContent, /How old is your sibling/); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('a', 'Do you have siblings?', true)");
    f.control.analysis = {is_question: true, question: 'Do you have siblings?', questions: ['Do you have siblings?']};
    await f.detect();
    f.run("updateTranscript('b', 'Why?', true)");
    f.control.analysis = {is_question: true, question: 'Why did you ask about siblings?', questions: ['Why did you ask about siblings?']};
    await f.detect();
    assert.equal(f.run('detectedQuestions.size'), 2);
    assert.match(f.get('questions-list').children[1].textContent, /Why did you ask about siblings/);
    assert.equal(f.get('questions-list').children.filter(node => node.textContent.includes('Why?')).length, 0); count++;
  }
  {
    const f = await fresh();
    f.run("updateTranscript('mixed', 'Python कोड compiles. पाइथन language?', false)");
    const displayed = f.get('transcript').children[0].textContent;
    assert.match(displayed, /Python \[unclear\] compiles/);
    assert.doesNotMatch(displayed, /[\u0900-\u097f]/);
    assert.doesNotMatch(f.run('contextText()'), /[\u0900-\u097f]/);
    assert.equal(f.get('latency').textContent, 'Unclear words marked');
    assert.equal(f.run('detectedQuestions.size'), 0);
    await f.detect();
    assert.equal(f.calls.length, 0);
    f.run("updateTranscript('mixed', 'Python code compiles. Is Python interpreted?', true)");
    f.control.analysis = {is_question: true, question: 'Is Python interpreted?', questions: ['Is Python interpreted?']};
    await f.detect();
    assert.doesNotMatch(f.calls[0].body.text, /\[unclear\]/);
    assert.equal(f.get('answer').disabled, false); count++;
  }
  {
    const f = await fresh();
    assert.equal(f.get('api-status').textContent, 'Session only');
    f.run('updateStatus()');
    assert.equal(f.get('status').textContent, 'Ready');
    f.get('clear').onclick(); await f.settle();
    assert.equal(f.get('context-count').textContent, '0 turns in context');
    assert.equal(f.get('latency').textContent, 'Waiting for audio'); count++;
  }
  return `${count} frontend tests passed`;
}

module.exports = runTests;
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
