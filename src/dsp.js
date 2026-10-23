// Small audio DSP helpers: resampling, PCM16 conversion, WAV encoding, voice activity detection.
// Pure functions/classes, unit-tested under Node.

/**
 * Streaming downsampler (e.g. 48 kHz mic -> 16 kHz for STT).
 * Averages `round(ratio)` input samples per output sample, which doubles as a cheap
 * anti-alias low-pass. Keeps fractional position across calls so frames join seamlessly.
 */
export class StreamResampler {
    constructor(inRate, outRate) {
        this.ratio = inRate / outRate;
        this.win = Math.max(1, Math.round(this.ratio));
        this.pos = 0;
        this.buf = new Float32Array(0);
    }

    /** @param {Float32Array} input @returns {Float32Array} */
    process(input) {
        const buf = new Float32Array(this.buf.length + input.length);
        buf.set(this.buf);
        buf.set(input, this.buf.length);
        const out = new Float32Array(Math.ceil(buf.length / this.ratio) + 1);
        let n = 0;
        while (this.pos + this.win <= buf.length) {
            const start = Math.floor(this.pos);
            let sum = 0;
            for (let k = 0; k < this.win; k++) sum += buf[start + k];
            out[n++] = sum / this.win;
            this.pos += this.ratio;
        }
        const drop = Math.min(Math.floor(this.pos), buf.length);
        this.buf = buf.slice(drop);
        this.pos -= drop;
        return out.slice(0, n);
    }
}

/** @param {Float32Array} f32 @returns {Int16Array} */
export function floatToInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
}

/** @param {Int16Array[]} parts @returns {Int16Array} */
export function concatInt16(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Int16Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

/**
 * Wraps mono PCM16 in a 44-byte RIFF/WAV header.
 * @param {Int16Array} pcm @param {number} sampleRate @returns {ArrayBuffer}
 */
export function encodeWav(pcm, sampleRate) {
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buffer);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);          // fmt chunk size
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);           // block align
    v.setUint16(34, 16, true);          // bits per sample
    str(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buffer, 44).set(pcm);
    return buffer;
}

/** Root-mean-square level of a frame in dBFS (-100 for silence). */
export function frameDb(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / Math.max(1, f32.length));
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/**
 * Energy-based voice activity detector with an adaptive noise floor.
 * Feed it consecutive frames; it reports speech start/end edges with hysteresis
 * so a short breath doesn't end the turn and a click doesn't start one.
 */
export class EnergyVad {
    /**
     * @param {object} o
     * @param {number} [o.sensitivity=60] 0..100, higher = triggers on quieter speech
     * @param {number} [o.startMs=120] Speech needed before "speechstart"
     * @param {number} [o.endMs=800] Silence needed before "speechend"
     */
    constructor({ sensitivity = 60, startMs = 120, endMs = 800 } = {}) {
        this.configure({ sensitivity, startMs, endMs });
        this.noiseDb = -60;
        this.speaking = false;
        this.voicedMs = 0;
        this.silentMs = 0;
        this.boostDb = 0;
    }

    configure({ sensitivity, startMs, endMs }) {
        if (sensitivity !== undefined) this.sensitivity = Math.max(0, Math.min(100, Number(sensitivity)));
        if (startMs !== undefined) this.startMs = Number(startMs);
        if (endMs !== undefined) this.endMs = Number(endMs);
    }

    /** Current trigger threshold in dBFS. */
    get thresholdDb() {
        const margin = 22 - this.sensitivity * 0.16;          // 22 dB (deaf) .. 6 dB (twitchy) above noise
        const floor = -60 + (100 - this.sensitivity) * 0.15;  // absolute minimum level
        return Math.max(this.noiseDb + margin, floor) + this.boostDb;
    }

    /**
     * @param {Float32Array} frame
     * @param {number} frameMs
     * @returns {{db: number, level: number, voiced: boolean, start: boolean, end: boolean}}
     */
    process(frame, frameMs) {
        const db = frameDb(frame);
        const voiced = db > this.thresholdDb;
        let start = false;
        let end = false;

        if (!this.speaking) {
            // Track background noise only while nobody is talking: fast down, slow up.
            const rate = db < this.noiseDb ? 0.2 : 0.02;
            this.noiseDb = Math.max(-85, Math.min(-35, this.noiseDb + (db - this.noiseDb) * rate));
            this.voicedMs = voiced ? this.voicedMs + frameMs : Math.max(0, this.voicedMs - frameMs * 2);
            if (this.voicedMs >= this.startMs) {
                this.speaking = true;
                this.silentMs = 0;
                start = true;
            }
        } else {
            this.silentMs = voiced ? 0 : this.silentMs + frameMs;
            if (this.silentMs >= this.endMs) {
                this.speaking = false;
                this.voicedMs = 0;
                end = true;
            }
        }
        const level = Math.max(0, Math.min(1, (db + 70) / 55));
        return { db, level, voiced, start, end };
    }

    reset() {
        this.speaking = false;
        this.voicedMs = 0;
        this.silentMs = 0;
    }
}
