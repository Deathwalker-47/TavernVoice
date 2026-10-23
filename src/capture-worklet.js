// AudioWorklet that slices the mic signal into 20 ms Float32 frames and posts them to the main thread.
class TavernVoiceCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.size = Math.round(sampleRate * 0.02);
        this.buf = new Float32Array(this.size);
        this.n = 0;
    }

    process(inputs) {
        const input = inputs[0] && inputs[0][0];
        if (input) {
            let i = 0;
            while (i < input.length) {
                const take = Math.min(this.size - this.n, input.length - i);
                this.buf.set(input.subarray(i, i + take), this.n);
                this.n += take;
                i += take;
                if (this.n === this.size) {
                    this.port.postMessage(this.buf, [this.buf.buffer]);
                    this.buf = new Float32Array(this.size);
                    this.n = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('tavern-voice-capture', TavernVoiceCapture);
