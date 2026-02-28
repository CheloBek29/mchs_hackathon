class RadioDSPWorklet extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'jammed',
      defaultValue: 0,
      minValue: 0,
      maxValue: 1
    }];
  }

  constructor() {
    super();
    this.phase = 0;
    this.env = 0;
    this.pinkState = 0;
    this.hpState = 0;
    this.lfoFreq = 15; // Hz
    this.tailActive = false;
    this.tailSamples = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === 'trigger_tail') {
        this.tailActive = true;
        // 150ms tail (assuming standard sampleRate around 44100 or 48000)
        // sampleRate is available globally in AudioWorkletGlobalScope
        this.tailSamples = Math.floor(0.15 * sampleRate);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // If no input channels and no tail active, we can return early
    if ((!input || !input.length || !input[0].length) && !this.tailActive) {
      return true;
    }

    const channelCount = output.length;
    // Use first input channel, or zeroes if there's no input but tail is active
    const inputChannel = (input && input[0]) ? input[0] : new Float32Array(output[0].length);

    // Filter coefficients
    const attackGain = Math.exp(-1.0 / (sampleRate * 0.01));
    const releaseGain = Math.exp(-1.0 / (sampleRate * 0.1));
    const alphaPink = 1000 / (0.5 * sampleRate);
    const alphaHp = 2000 / (0.5 * sampleRate); // Highpass for the tail Tssshk
    const lfoInc = 2 * Math.PI * this.lfoFreq / sampleRate;

    // Evaluate jamming state (1 = jammed, 0 = normal)
    const isJammed = parameters.jammed && parameters.jammed.length
      ? parameters.jammed[0] > 0.5
      : false;

    for (let i = 0; i < output[0].length; i++) {
      let x = inputChannel[i];

      let out = 0;

      if (isJammed) {
        // When jammed, output overwhelming noise
        let jNoise = Math.random() * 2 - 1;
        this.pinkState += alphaPink * (jNoise - this.pinkState);
        out = jNoise * 0.4 + this.pinkState * 0.8;

        // Hard clip for loud distortion
        if (out > 1.0) out = 1.0;
        else if (out < -1.0) out = -1.0;
      } else {
        // Envelope follower (for ducking the squelch)
        let absX = Math.abs(x);
        this.env = this.env < absX
          ? absX + attackGain * (this.env - absX)
          : absX + releaseGain * (this.env - absX);

        let envVal = Math.min(this.env * 0.8, 1.0);

        // LFO for multiplicative noise / fading
        this.phase += lfoInc;
        if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;
        let lfo = 0.8 + 0.2 * Math.sin(this.phase);

        // Modulation noise
        let mNoise = (Math.random() * 2 - 1) * 0.05;
        let modulated = x * lfo + x * mNoise;

        // Background pink-like noise
        let wNoise = Math.random() * 2 - 1;
        this.pinkState += alphaPink * (wNoise - this.pinkState);
        let bgStatic = wNoise * 0.3 + this.pinkState * 0.7;

        // Squelch ducking based on voice envelope
        let bgLevel = 0.03;
        let ducking = 1.0 - envVal;
        let squelch = bgStatic * (bgLevel + 0.15 * ducking);

        out = modulated + squelch;

        // Tail generation (Tssshk)
        if (this.tailActive && this.tailSamples > 0) {
          this.tailSamples--;
          let tNoise = Math.random() * 2 - 1;
          this.hpState += alphaHp * (tNoise - this.hpState);
          let hpOut = tNoise - this.hpState; // highpass filter trick
          out += hpOut * 0.6; // Tail burst volume

          if (this.tailSamples <= 0) {
            this.tailActive = false;
          }
        }

        // Hard clip just in case
        if (out > 1.0) out = 1.0;
        else if (out < -1.0) out = -1.0;
      }

      // Write to output channels
      for (let ch = 0; ch < channelCount; ch++) {
        output[ch][i] = out;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('radio-dsp-worklet', RadioDSPWorklet);
