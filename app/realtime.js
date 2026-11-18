/* Browser -> OpenAI Realtime transcription. The project API key stays on the server. */
function sanitizeEnglishTranscript(text) {
  // Keep genuine Latin names and punctuation, but never present another script
  // as English. Mark uncertainty instead of silently deleting words.
  const cleaned = String(text).normalize('NFC').replace(/[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '');
  return cleaned.replace(/\S+/gu, token => {
    for (const letter of token) {
      if ((/[\p{L}\p{M}]/u.test(letter) && !/[\p{Script=Latin}\p{Script=Inherited}]/u.test(letter))
          || /\p{Extended_Pictographic}/u.test(letter) || letter === '\uFFFD') return '[unclear]';
    }
    return token;
  }).replace(/(?:\[unclear\]\s*){2,}/g, '[unclear] ').trim();
}

globalThis.sanitizeEnglishTranscript = sanitizeEnglishTranscript;

class LiveTranscription {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.closed = true; this.ready = false; this.stopping = false; this.failed = false;
    this.partials = new Map(); this.finishedItems = new Set();
    this.outstandingCommits = 0; this.finalWaiters = new Set();
    this.preRoll = []; this.segmentSamples = 0; this.voicedSamples = 0; this.silenceSamples = 0;
    this.firstAudioAt = null; this.latencyReported = false; this.stopPromise = null;
  }

  async connect(stream, token) {
    if (!this.closed || this.stopPromise) throw new Error('The audio connection has already started.');
    if (!token?.value || !token?.model) throw new Error('No valid temporary credential was received.');
    this.closed = false;
    try {
      this.audio = new AudioContext({sampleRate: 24000, latencyHint: 'interactive'});
      if (this.audio.sampleRate !== 24000) throw new Error('Your browser does not support 24 kHz audio.');
      await this.audio.audioWorklet.addModule('/audio-worklet.js');
      if (this.closed || this.stopping) throw new Error('Transcription canceled.');
      this.source = this.audio.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      this.processor = new AudioWorkletNode(this.audio, 'capture');
      this.muted = this.audio.createGain(); this.muted.gain.value = 0;
      this.processor.port.onmessage = event => this.receiveAudio(event.data);
      this.source.connect(this.processor); this.processor.connect(this.muted); this.muted.connect(this.audio.destination);
      await this.audio.resume();
      if (this.closed || this.stopping) throw new Error('Transcription canceled.');
      const transcription = {...token.transcription, model: token.model, languages: ['en'],
        delay: token.transcription?.delay || 'medium'};
      const socket = this.socket = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription',
        ['realtime', 'openai-insecure-api-key.' + token.value]);
      token = null;
      await new Promise((resolve, reject) => {
        this.resolveReady = resolve; this.rejectReady = reject;
        this.readyTimer = setTimeout(() => this.fail('Could not connect to the live transcription service.'), 20000);
        socket.onopen = () => {
          if (this.closed || this.stopping) return;
          this.send({type: 'session.update', session: {type: 'transcription', audio: {input: {
            format: {type: 'audio/pcm', rate: 24000}, transcription, turn_detection: null
          }}}});
        };
        socket.onmessage = event => {
          if (this.closed) return;
          let data;
          try { data = JSON.parse(event.data); }
          catch { this.fail('The service returned an invalid audio event.'); return; }
          this.handleEvent(data);
        };
        socket.onerror = () => this.fail('Live transcription connection error.');
        socket.onclose = () => {
          if (!this.closed && !this.stopping) this.fail('Transcription disconnected. Click Listen to Meet to reconnect.');
        };
      });
    } catch (error) {
      if (!this.stopping && !this.closed) this.fail(error.message || 'Could not start audio.');
      await this.stop({drain: false});
      throw error;
    }
  }

  send(event) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > 262144) {
      this.fail('The audio connection is falling behind. Stop and restart capture.'); return false;
    }
    try { this.socket.send(JSON.stringify(event)); return true; }
    catch { this.fail('Could not send audio. Restart capture.'); return false; }
  }

  append(packet) {
    const bytes = new Uint8Array(packet.pcm);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    if (!this.send({type: 'input_audio_buffer.append', audio: btoa(binary)})) return false;
    this.segmentSamples += bytes.length / 2;
    return true;
  }

  receiveAudio(packet) {
    if (!this.ready || this.closed || this.stopping || !packet?.pcm) return;
    this.callbacks.onLevel?.(packet.rms);
    const count = packet.pcm.byteLength / 2;
    const speech = packet.rms > Number(this.callbacks.getThreshold?.() ?? 0.008);
    if (!this.segmentSamples && !speech) {
      this.preRoll.push(packet); if (this.preRoll.length > 25) this.preRoll.shift(); return;
    }
    if (!this.segmentSamples) {
      if (this.firstAudioAt === null) this.firstAudioAt = performance.now();
      for (const previous of this.preRoll) if (!this.append(previous)) return;
      this.preRoll = [];
    }
    if (!this.append(packet)) return;
    if (speech) { this.voicedSamples += count; this.silenceSamples = 0; }
    else this.silenceSamples += count;
    if (this.silenceSamples >= 12000 || this.segmentSamples >= 360000) this.commitSegment();
  }

  commitSegment() {
    if (!this.segmentSamples) return;
    if (this.voicedSamples >= 2400) {
      if (this.send({type: 'input_audio_buffer.commit'})) this.outstandingCommits++;
    } else this.send({type: 'input_audio_buffer.clear'});
    this.segmentSamples = this.voicedSamples = this.silenceSamples = 0; this.preRoll = [];
  }

  handleEvent(event) {
    if (event.type === 'session.updated') {
      if (this.ready || this.stopping) return;
      this.ready = true; clearTimeout(this.readyTimer);
      this.resolveReady?.(); this.resolveReady = this.rejectReady = null;
    } else if (event.type === 'input_audio_buffer.committed') {
      this.callbacks.onOrder?.(event.item_id, event.previous_item_id ?? null);
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const id = event.item_id;
      if (!id || this.finishedItems.has(id) || typeof event.delta !== 'string') return;
      const text = (this.partials.get(id) || '') + event.delta; this.partials.set(id, text);
      if (!this.latencyReported && this.firstAudioAt !== null && text.trim()) {
        this.latencyReported = true;
        this.callbacks.onLatency?.(Math.max(0, performance.now() - this.firstAudioAt));
      }
      this.callbacks.onPartial?.(id, sanitizeEnglishTranscript(text));
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const id = event.item_id;
      if (!id || this.finishedItems.has(id)) return;
      this.finishedItems.add(id); this.partials.delete(id);
      this.outstandingCommits = Math.max(0, this.outstandingCommits - 1);
      this.callbacks.onFinal?.(id, sanitizeEnglishTranscript(event.transcript || '')); this.finishWaiters();
    } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
      if (!this.finishedItems.has(event.item_id)) {
        this.finishedItems.add(event.item_id);
        this.outstandingCommits = Math.max(0, this.outstandingCommits - 1); this.finishWaiters();
      }
      this.fail('Could not transcribe an audio segment. Restart capture.');
    } else if (event.type === 'error') {
      this.fail('The transcription service rejected the session or audio. Check the model and your API access.');
    }
  }

  finishWaiters() {
    if (!this.outstandingCommits) for (const finish of [...this.finalWaiters]) finish();
  }

  waitForFinals() {
    if (!this.outstandingCommits) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.finalWaiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, 1500); this.finalWaiters.add(finish);
    });
  }

  fail(message) {
    if (this.failed || this.closed || this.stopping) return;
    this.failed = true;
    this.rejectReady?.(new Error(message)); this.rejectReady = this.resolveReady = null;
    this.callbacks.onError?.(message); void this.stop({drain: false});
  }

  stop({drain = true} = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      if (drain && this.ready && !this.failed) { this.commitSegment(); await this.waitForFinals(); }
      this.closed = true; this.ready = false; clearTimeout(this.readyTimer);
      this.rejectReady?.(new Error('Transcription canceled.')); this.rejectReady = this.resolveReady = null;
      for (const finish of [...this.finalWaiters]) finish();
      if (this.processor) { this.processor.port.onmessage = null; this.processor.disconnect(); }
      this.source?.disconnect(); this.muted?.disconnect();
      if (this.socket) {
        this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
        try { this.socket.close(); } catch { /* Already closed. */ }
      }
      if (this.audio && this.audio.state !== 'closed') {
        try { await this.audio.close(); } catch { /* Already closed. */ }
      }
      this.preRoll = []; this.partials.clear(); this.callbacks.onLevel?.(0);
    })();
    return this.stopPromise;
  }
}

globalThis.LiveTranscription = LiveTranscription;
