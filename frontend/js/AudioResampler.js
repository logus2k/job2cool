/**
 * AudioResampler - Resamples mono Float32 audio (e.g. 48kHz) to Int16 PCM (e.g. 16kHz).
 */
export class AudioResampler {
    constructor(inRate, outRate) {
        this._ratio = inRate / outRate;
        this._carry = new Float32Array(0);
    }

    pushFloat32(chunk) {
        const input = new Float32Array(this._carry.length + chunk.length);
        input.set(this._carry, 0);
        input.set(chunk, this._carry.length);

        const outLen = Math.floor(input.length / this._ratio);
        if (outLen === 0) {
            this._carry = input;
            return null;
        }

        const out = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const idx = i * this._ratio;
            const i0 = Math.floor(idx);
            const i1 = Math.min(i0 + 1, input.length - 1);
            const frac = idx - i0;
            const sample = input[i0] * (1 - frac) + input[i1] * frac;
            const s = Math.max(-1, Math.min(1, sample));
            out[i] = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0;
        }

        const remainderStart = Math.floor(outLen * this._ratio);
        this._carry = input.subarray(remainderStart);
        return out;
    }

    reset() {
        this._carry = new Float32Array(0);
    }
}
