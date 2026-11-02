// Shared AudioContext, mic capture and the speech playback queue.

import { StreamResampler, floatToInt16, concatInt16, EnergyVad } from './dsp.js';

const STT_RATE = 16000;
let sharedCtx = null;

/**
 * Returns the shared AudioContext, creating/resuming it.
 * Call this synchronously inside a click handler at least once: Safari permanently
 * suspends contexts created outside a user gesture.
 */
export function getAudioContext() {
    if (!sharedCtx || sharedCtx.state === 'closed') {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        sharedCtx = new Ctx({ latencyHint: 'interactive' });
    }
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
    return sharedCtx;
}

const workletLoaded = new WeakSet();

/**
 * Microphone input: echo-cancelled capture -> 16 kHz PCM16 frames + energy VAD.
 *
 * Events (EventTarget, detail in e.detail):
 *  frame       {pcm: Int16Array, level: number}  every ~20 ms (silence while muted)
 *  speechstart {}                                VAD or push-to-talk start
 *  speechend   {pcm: Int16Array, ms: number}     one utterance, with ~350 ms of pre-roll
 */
export class MicInput extends EventTarget {
    constructor() {
        super();
        this.stream = null;
        this.nodes = [];
        this.vad = new EnergyVad();
        this.muted = false;
        this.manual = false;   // push-to-talk: VAD ignored, recording follows pttDown/pttUp
        this.pttHeld = false;
        this.utterance = null; // Int16Array[] while recording
        this.preroll = [];
        this.prerollMs = 350;
        this.maxMs = 30000;
    }

    /** @param {{deviceId?: string, sensitivity?: number, endMs?: number, manual?: boolean}} o */
    async start(o = {}) {
        const ctx = getAudioContext();
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Microphone needs a secure page: open SillyTavern via http://localhost or https://');
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: o.deviceId ? { exact: o.deviceId } : undefined,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            },
        });
        if (!workletLoaded.has(ctx)) {
            await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
            workletLoaded.add(ctx);
        }
        const source = ctx.createMediaStreamSource(this.stream);
        const node = new AudioWorkletNode(ctx, 'tavern-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const sink = ctx.createGain();
        sink.gain.value = 0; // keep the node pulled by the graph without hearing ourselves
        source.connect(node).connect(sink).connect(ctx.destination);
        this.nodes = [source, node, sink];

        this.resampler = new StreamResampler(ctx.sampleRate, STT_RATE);
        this.configure(o);
        node.port.onmessage = (e) => this.#onFrame(e.data);
    }

    configure({ sensitivity, endMs, manual } = {}) {
        this.vad.configure({ sensitivity, endMs });
        if (manual !== undefined) {
            this.manual = !!manual;
            this.#cancelUtterance();
        }
    }

    #emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    #cancelUtterance() {
        this.utterance = null;
        this.vad.reset();
    }

    #onFrame(f32) {
        const pcmF = this.resampler.process(f32);
        if (!pcmF.length) return;
        const frameMs = (pcmF.length / STT_RATE) * 1000;

        if (this.muted) {
            if (this.utterance) this.#cancelUtterance();
            this.#emit('frame', { pcm: new Int16Array(pcmF.length), level: 0 });
            return;
        }

        const v = this.vad.process(pcmF, frameMs);
        const pcm = floatToInt16(pcmF);
        const gated = this.manual && !this.pttHeld;
        this.#emit('frame', { pcm: gated ? new Int16Array(pcm.length) : pcm, level: v.level, voiced: v.voiced });

        // Pre-roll ring buffer so the first syllable isn't clipped.
        this.preroll.push(pcm);
        let prerollLen = this.preroll.reduce((n, p) => n + p.length, 0);
        while (prerollLen > (this.prerollMs / 1000) * STT_RATE) prerollLen -= this.preroll.shift().length;

        if (this.manual) {
            if (this.utterance) this.utterance.push(pcm);
            return;
        }

        if (v.start) {
            this.utterance = [...this.preroll];
            this.#emit('speechstart');
        } else if (this.utterance) {
            this.utterance.push(pcm);
        }
        const len = this.utterance ? this.utterance.reduce((n, p) => n + p.length, 0) : 0;
        if (this.utterance && (v.end || len > (this.maxMs / 1000) * STT_RATE)) {
            if (!v.end) this.vad.reset();
            this.#finish();
        }
    }

    #finish() {
        const pcm = concatInt16(this.utterance);
        this.utterance = null;
        this.#emit('speechend', { pcm, ms: (pcm.length / STT_RATE) * 1000 });
    }

    pttDown() {
        if (this.pttHeld || this.muted) return;
        this.pttHeld = true;
        this.utterance = [...this.preroll.slice(-5)];
        this.#emit('speechstart');
    }

    pttUp() {
        if (!this.pttHeld) return;
        this.pttHeld = false;
        if (this.utterance) this.#finish();
    }

    /** True while the VAD thinks someone is talking (or PTT is held). */
    get speaking() {
        return this.manual ? this.pttHeld : this.vad.speaking;
    }

    stop() {
        for (const n of this.nodes) {
            try { n.disconnect(); } catch { /* already gone */ }
        }
        this.nodes = [];
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.utterance = null;
    }
}

/**
 * Ordered, gapless playback of TTS chunks. Each chunk's audio is fetched ahead of time
 * (up to `prefetch` in flight) so the next sentence is ready when the current one ends.
 *
 * Events: chunkstart {meta}, chunkend {meta}, idle, error {error}, stopped
 */
export class SpeechPlayer extends EventTarget {
    /** Roughly how long Grok TTS takes to return a sentence. */
    static SYNTH_LEAD_MS = 1200;

    constructor({ prefetch = 3 } = {}) {
        super();
        this.prefetch = prefetch;
        this.items = [];
        this.gen = 0;
        this.pumping = false;
        this.current = null;
        this.volume = 1;
        this.notBefore = 0; // timestamp; playback waits until then (used to let the phone ring)
    }

    #graph() {
        const ctx = getAudioContext();
        if (this.ctx !== ctx) {
            this.ctx = ctx;
            this.gain = ctx.createGain();
            this.gain.gain.value = this.volume;
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 512;
            this.levelBuf = new Float32Array(this.analyser.fftSize);
            this.gain.connect(this.analyser).connect(ctx.destination);
        }
        return ctx;
    }

    /** Output node other sounds (ringtone, chimes) can share. */
    get output() {
        this.#graph();
        return this.gain;
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1.5, Number(v)));
        if (this.gain) this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }

    /** Temporarily lower the voice while the user might be interrupting. */
    duck(on) {
        if (!this.gain) return;
        this.gain.gain.setTargetAtTime(on ? this.volume * 0.25 : this.volume, this.ctx.currentTime, 0.04);
    }

    /**
     * @param {(signal: AbortSignal, needed: Promise<void>) => Promise<ArrayBuffer>} fetchAudio
     *        `needed` resolves when this chunk's audio must start being made so it plays without
     *        a gap: optional extras (voice tags) should give up then.
     * @param {any} meta Passed back on chunkstart/chunkend (e.g. the text for captions)
     */
    enqueue(fetchAudio, meta) {
        this.#graph();
        let resolveNeeded;
        const needed = new Promise(r => { resolveNeeded = r; });
        this.items.push({ fetchAudio, meta, controller: new AbortController(), promise: null, needed, resolveNeeded, armed: false });
        this.#arm();
        this.#prefetchAhead();
        this.#pump();
    }

    /**
     * The next chunk is needed when the one playing is about to end, less the time speech
     * synthesis takes. With nothing playing it is needed now.
     */
    #arm() {
        const next = this.items[0];
        if (!next || next.armed) return;
        next.armed = true;
        const left = this.current ? (this.playEndsAt - Date.now()) - SpeechPlayer.SYNTH_LEAD_MS : 0;
        if (left > 0) setTimeout(next.resolveNeeded, left);
        else next.resolveNeeded();
    }

    #prefetchAhead() {
        for (const item of this.items.slice(0, this.prefetch)) {
            if (item.promise) continue;
            item.promise = item.fetchAudio(item.controller.signal, item.needed)
                .then(buf => this.ctx.decodeAudioData(buf))
                .catch(err => {
                    item.error = err;
                    return null;
                });
        }
    }

    async #pump() {
        if (this.pumping) return;
        this.pumping = true;
        const myGen = this.gen;
        while (this.items.length && myGen === this.gen) {
            const item = this.items[0];
            this.#arm();
            this.#prefetchAhead();
            const audio = await item.promise;
            if (myGen !== this.gen) break;
            this.items.shift();
            if (!audio) {
                if (item.error?.name !== 'AbortError') this.dispatchEvent(new CustomEvent('error', { detail: { error: item.error } }));
                continue;
            }
            const wait = this.notBefore - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            if (myGen !== this.gen) break;
            this.dispatchEvent(new CustomEvent('chunkstart', { detail: { meta: item.meta } }));
            await this.#play(audio);
            this.dispatchEvent(new CustomEvent('chunkend', { detail: { meta: item.meta } }));
        }
        this.pumping = false;
        if (this.items.length) {
            this.#pump(); // stop() + enqueue() raced the old loop
        } else if (myGen === this.gen) {
            this.dispatchEvent(new Event('idle'));
        }
    }

    #play(buffer) {
        return new Promise((resolve) => {
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(this.gain);
            src.onended = () => {
                if (this.current === src) this.current = null;
                resolve();
            };
            this.current = src;
            this.playEndsAt = Date.now() + buffer.duration * 1000;
            src.start();
            this.#arm();
        });
    }

    /** Barge-in: drop everything queued and cut the current sentence. */
    stop() {
        const wasBusy = this.busy;
        this.gen++;
        for (const item of this.items) item.controller.abort();
        this.items = [];
        try { this.current?.stop(); } catch { /* not started */ }
        this.current = null;
        this.duck(false);
        if (wasBusy) this.dispatchEvent(new Event('stopped'));
    }

    get busy() {
        return this.items.length > 0 || !!this.current;
    }

    get playing() {
        return !!this.current;
    }

    /** 0..1 loudness of what is playing right now, for the avatar animation. */
    level() {
        if (!this.analyser || !this.current) return 0;
        this.analyser.getFloatTimeDomainData(this.levelBuf);
        let sum = 0;
        for (const s of this.levelBuf) sum += s * s;
        return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
    }
}

/** Synthesized phone sounds, so the extension ships no audio files. */
export const Sounds = {
    tone(dest, { freqs = [440], start = 0, duration = 0.2, gain = 0.06, type = 'sine' } = {}) {
        const ctx = getAudioContext();
        const t0 = ctx.currentTime + start;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
        g.gain.setValueAtTime(gain, t0 + duration - 0.03);
        g.gain.linearRampToValueAtTime(0, t0 + duration);
        g.connect(dest);
        for (const f of freqs) {
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.value = f;
            o.connect(g);
            o.start(t0);
            o.stop(t0 + duration + 0.02);
        }
    },

    /** UK-style double ring ("brr-brr ... brr-brr"). Returns a stop() function. */
    ringback(dest) {
        let stopped = false;
        const ring = () => {
            if (stopped) return;
            this.tone(dest, { freqs: [400, 450], duration: 0.4, gain: 0.05 });
            this.tone(dest, { freqs: [400, 450], start: 0.6, duration: 0.4, gain: 0.05 });
        };
        ring();
        const timer = setInterval(ring, 3000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    },

    connect(dest) {
        this.tone(dest, { freqs: [660], duration: 0.09, gain: 0.05 });
        this.tone(dest, { freqs: [880], start: 0.1, duration: 0.12, gain: 0.05 });
    },

    hangup(dest) {
        this.tone(dest, { freqs: [480], duration: 0.12, gain: 0.05 });
        this.tone(dest, { freqs: [360], start: 0.14, duration: 0.18, gain: 0.05 });
    },

    error(dest) {
        this.tone(dest, { freqs: [300], duration: 0.25, gain: 0.05, type: 'triangle' });
    },
};
