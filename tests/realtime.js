const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const sent = [], partials = [], finals = [], orders = [], errors = [], latencies = [];
  let socket, now = 1000;
  class FakeSocket {
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols;
      this.readyState = 1; this.bufferedAmount = 0; socket = this;
    }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  class FakeAudio {
    constructor() {
      this.sampleRate = 24000; this.state = 'running'; this.destination = {};
      this.audioWorklet = {addModule: async () => {}};
    }
    createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    createGain() { return {gain: {}, connect() {}, disconnect() {}}; }
    async resume() {}
    async close() { this.state = 'closed'; }
  }
  const context = {
    WebSocket: FakeSocket, AudioContext: FakeAudio, MediaStream: class {},
    AudioWorkletNode: class { constructor() { this.port = {}; } connect() {} disconnect() {} },
    setTimeout, clearTimeout, performance: {now: () => now}, btoa: text => Buffer.from(text, 'binary').toString('base64'),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/realtime.js'), 'utf8'), context);
  const live = new context.LiveTranscription({
    onPartial: (...args) => partials.push(args), onFinal: (...args) => finals.push(args),
    onOrder: (...args) => orders.push(args), onError: error => errors.push(error), onLatency: ms => latencies.push(ms),
  });
  const transcription = {model: 'gpt-live-transcribe', languages: ['en'], delay: 'medium',
    prompt: 'English conversation about software.', keywords: ['Python', 'bytecode']};
  const start = () => live.connect({getAudioTracks: () => []}, {value: 'fake-test-token', model: 'gpt-live-transcribe', transcription});
  const connect = async () => {
    const pending = start(); await new Promise(resolve => setImmediate(resolve));
    socket.onopen(); socket.onmessage({data: JSON.stringify({type: 'session.updated'})}); await pending;
  };
  return {live, sent, partials, finals, orders, errors, latencies, start, connect,
    socket: () => socket, time: value => { now = value; }, sanitize: context.sanitizeEnglishTranscript};
}

async function runTests() {
  let count = 0;
  {
    const f = fixture(); await f.connect();
    assert.equal(f.socket().url, 'wss://api.openai.com/v1/realtime?intent=transcription');
    assert.equal(f.sent[0].type, 'session.update');
    const config = f.sent[0].session.audio.input.transcription;
    assert.equal(config.delay, 'medium');
    assert.deepEqual([...config.languages], ['en']);
    assert.equal(config.prompt, 'English conversation about software.');
    assert.deepEqual([...config.keywords], ['Python', 'bytecode']);
    assert.equal(f.sent[0].session.audio.input.turn_detection, null);
    const packet = rms => ({pcm: new Int16Array(240).buffer, rms});
    for (let i = 0; i < 30; i++) f.live.receiveAudio(packet(0));
    assert.equal(f.sent.length, 1);
    for (let i = 0; i < 10; i++) f.live.receiveAudio(packet(.2));
    for (let i = 0; i < 50; i++) f.live.receiveAudio(packet(0));
    assert.equal(f.sent.filter(event => event.type === 'input_audio_buffer.append').length, 85);
    assert.equal(f.sent.at(-1).type, 'input_audio_buffer.commit');
    f.live.handleEvent({type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null});
    f.live.handleEvent({type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' '});
    assert.equal(f.latencies.length, 0);
    f.time(1600);
    f.live.handleEvent({type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Why?'});
    assert.equal(f.latencies[0], 600);
    assert.equal(f.partials.at(-1)[1], 'Why?');
    f.live.handleEvent({type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Why?'});
    assert.equal(f.finals[0][1], 'Why?');
    assert.equal(f.orders[0][0], 'a');
    assert.equal(f.live.outstandingCommits, 0);
    await f.live.stop();
    assert.equal(f.live.audio.state, 'closed');
    assert.equal(f.socket().readyState, 3); count++;
  }
  {
    const f = fixture(); await f.connect();
    f.socket().bufferedAmount = 262145;
    f.live.receiveAudio({pcm: new Int16Array(240).buffer, rms: .2});
    await f.live.stop({drain: false});
    assert.equal(f.errors.length, 1);
    assert.equal(f.live.closed, true); count++;
  }
  {
    const f = fixture(); const connecting = f.start();
    await new Promise(resolve => setImmediate(resolve));
    await f.live.stop({drain: false});
    await assert.rejects(connecting, /canceled/);
    assert.equal(f.errors.length, 0); count++;
  }
  {
    const packets = []; let Processor;
    const context = {
      AudioWorkletProcessor: class { constructor() { this.port = {postMessage: packet => packets.push(packet)}; } },
      registerProcessor: (name, type) => { assert.equal(name, 'capture'); Processor = type; },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/audio-worklet.js'), 'utf8'), context);
    const processor = new Processor();
    for (let i = 0; i < 4; i++) processor.process([[new Float32Array(128).fill(.5), new Float32Array(128).fill(.5)]]);
    assert.equal(packets.length, 2);
    assert.equal(packets[0].pcm.byteLength, 480);
    assert.equal(new Int16Array(packets[0].pcm)[0], 16384);
    assert.equal(packets[0].rms, .5); count++;
  }
  {
    const f = fixture(); await f.connect();
    const packet = rms => ({pcm: new Int16Array(240).buffer, rms});
    // A 90 ms click/noise is discarded, while a 100 ms word can commit.
    for (let i = 0; i < 9; i++) f.live.receiveAudio(packet(.2));
    for (let i = 0; i < 50; i++) f.live.receiveAudio(packet(0));
    assert.equal(f.sent.at(-1).type, 'input_audio_buffer.clear');
    assert.equal(f.live.outstandingCommits, 0);
    for (let i = 0; i < 10; i++) f.live.receiveAudio(packet(.2));
    for (let i = 0; i < 49; i++) f.live.receiveAudio(packet(0));
    assert.equal(f.sent.at(-1).type, 'input_audio_buffer.append');
    f.live.receiveAudio(packet(0));
    assert.equal(f.sent.at(-1).type, 'input_audio_buffer.commit');
    assert.equal(f.live.outstandingCommits, 1);
    await f.live.stop({drain: false}); count++;
  }
  {
    const f = fixture(); await f.connect();
    const packet = {pcm: new Int16Array(240).buffer, rms: .2};
    for (let i = 0; i < 1500; i++) f.live.receiveAudio(packet);
    assert.equal(f.sent.at(-1).type, 'input_audio_buffer.commit');
    assert.equal(f.live.segmentSamples, 0);
    f.live.receiveAudio(packet);
    assert.equal(f.sent.at(-1).type, 'input_audio_buffer.append');
    assert.equal(f.live.segmentSamples, 240);
    await f.live.stop({drain: false}); count++;
  }
  {
    const f = fixture();
    assert.equal(f.sanitize('Python पाइथन code is interpreted.'), 'Python [unclear] code is interpreted.');
    assert.equal(f.sanitize('Python कोड भाषा'), 'Python [unclear]');
    assert.equal(f.sanitize('José uses Python — print("hello") at 3.14.'), 'José uses Python — print("hello") at 3.14.');
    assert.equal(f.sanitize('Python\u200b code\u0000 is valid.'), 'Python code is valid.');
    assert.equal(f.sanitize('A � token'), 'A [unclear] token'); count++;
    assert.equal(f.sanitize('A ि token'), 'A [unclear] token');
    assert.equal(f.sanitize('Python 🚀 code'), 'Python [unclear] code');
    assert.equal(f.sanitize('Jose\u0301 writes code.'), 'José writes code.');
  }
  {
    const f = fixture(); await f.connect();
    f.live.handleEvent({type: 'conversation.item.input_audio_transcription.delta', item_id: 'mixed', delta: 'Python पाइ'});
    f.live.handleEvent({type: 'conversation.item.input_audio_transcription.delta', item_id: 'mixed', delta: 'थन code'});
    assert.equal(f.partials.at(-1)[1], 'Python [unclear] code');
    f.live.handleEvent({type: 'conversation.item.input_audio_transcription.completed', item_id: 'mixed', transcript: 'Python code is interpreted.'});
    assert.equal(f.finals.at(-1)[1], 'Python code is interpreted.');
    assert.ok([...f.partials, ...f.finals].every(([, text]) => !/[\u0900-\u097f]/.test(text)));
    await f.live.stop({drain: false}); count++;
  }
  return `${count} realtime transport tests passed`;
}

module.exports = runTests;
if (require.main === module) runTests().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
