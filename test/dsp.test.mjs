import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamResampler, floatToInt16, encodeWav, concatInt16, EnergyVad, frameDb } from '../src/dsp.js';

const tone = (n, amp, rate = 16000, hz = 220) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));

test('resampler 48k -> 16k keeps duration across uneven frames', () => {
    const r = new StreamResampler(48000, 16000);
    let total = 0;
    for (const size of [128, 128, 333, 960, 1, 4000]) total += r.process(new Float32Array(size)).length;
    const expected = (128 + 128 + 333 + 960 + 1 + 4000) / 3;
    assert.ok(Math.abs(total - expected) <= 2, `got ${total}, expected ~${expected}`);
});

test('resampler 44.1k -> 16k ratio', () => {
    const r = new StreamResampler(44100, 16000);
    const out = r.process(new Float32Array(44100));
    assert.ok(Math.abs(out.length - 16000) <= 3);
});

test('floatToInt16 clamps', () => {
    assert.deepEqual([...floatToInt16(Float32Array.from([0, 1, -1, 2, -2]))], [0, 32767, -32768, 32767, -32768]);
});

test('encodeWav writes a valid header', () => {
    const pcm = concatInt16([Int16Array.from([1, 2]), Int16Array.from([3])]);
    const buf = encodeWav(pcm, 16000);
    const v = new DataView(buf);
    const tag = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    assert.equal(tag(0), 'RIFF');
    assert.equal(tag(8), 'WAVE');
    assert.equal(tag(36), 'data');
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getUint32(40, true), 6);
    assert.equal(buf.byteLength, 50);
    assert.equal(v.getInt16(48, true), 3);
});

test('frameDb', () => {
    assert.equal(frameDb(new Float32Array(10)), -100);
    assert.ok(Math.abs(frameDb(new Float32Array(10).fill(1)) - 0) < 1e-9);
});

test('VAD: noise stays quiet, speech starts and ends with hysteresis', () => {
    const vad = new EnergyVad({ sensitivity: 60, startMs: 100, endMs: 600 });
    const events = [];
    const feed = (amp, ms) => {
        for (let t = 0; t < ms; t += 20) {
            const r = vad.process(tone(320, amp), 20);
            if (r.start) events.push('start');
            if (r.end) events.push('end');
        }
    };
    feed(0.002, 1000);   // background hiss (~-57 dBFS)
    assert.deepEqual(events, []);
    feed(0.2, 600);      // talking
    assert.deepEqual(events, ['start']);
    feed(0.002, 300);    // short breath: should NOT end the turn
    feed(0.2, 200);
    assert.deepEqual(events, ['start']);
    feed(0.002, 800);    // done talking
    assert.deepEqual(events, ['start', 'end']);
});

test('VAD boost makes barge-in harder', () => {
    const vad = new EnergyVad({ sensitivity: 60 });
    const base = vad.thresholdDb;
    vad.boostDb = 10;
    assert.equal(vad.thresholdDb, base + 10);
});
