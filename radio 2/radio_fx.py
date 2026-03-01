import numpy as np
import scipy.io.wavfile as wavfile
from scipy.signal import butter, lfilter

def butter_bandpass(lowcut, highcut, fs, order=4):
    """Create a Butterworth bandpass filter."""
    nyq = 0.5 * fs
    low = lowcut / nyq
    high = highcut / nyq
    b, a = butter(order, [low, high], btype='band')
    return b, a

def bandpass_filter(data, lowcut, highcut, fs, order=4):
    """Apply the bandpass filter to the data."""
    b, a = butter_bandpass(lowcut, highcut, fs, order=order)
    y = lfilter(b, a, data)
    return y

def envelope_follower(data, fs, attack_time=0.01, release_time=0.1):
    """
    Calculate the amplitude envelope of a signal.
    """
    attack_gain = np.exp(-1.0 / (fs * attack_time))
    release_gain = np.exp(-1.0 / (fs * release_time))
    
    envelope = np.zeros_like(data)
    env_curr = 0.0
    for i in range(len(data)):
        env_in = abs(data[i])
        if env_curr < env_in:
            env_curr = env_in + attack_gain * (env_curr - env_in)
        else:
            env_curr = env_in + release_gain * (env_curr - env_in)
        envelope[i] = env_curr
    return envelope

def process_radio_effect(input_file, output_file):
    print(f"Reading {input_file}...")
    try:
        fs, data = wavfile.read(input_file)
    except FileNotFoundError:
        print(f"Error: {input_file} not found. Please provide an input WAV file.")
        return
        
    # Convert to mono if stereo
    if len(data.shape) > 1:
        data = data.mean(axis=1)

    # Normalize input from -1.0 to 1.0
    if np.issubdtype(data.dtype, np.integer):
        max_val = np.iinfo(data.dtype).max
        data = data.astype(np.float32) / max_val
    else:
        data = data.astype(np.float32)
        if np.max(np.abs(data)) > 0:
            data = data / np.max(np.abs(data))

    print("1. Applying Bandpass Filter (300 Hz - 3000 Hz)...")
    data_bp = bandpass_filter(data, 300.0, 3000.0, fs, order=4)

    print("2. Applying Dynamic Range Compression & Saturation...")
    # Overdrive the signal
    drive = 5.0
    overdriven = data_bp * drive
    # Soft clipping using tanh
    saturated = np.tanh(overdriven)
    
    print("3. Applying Multiplicative/Signal-Dependent Noise...")
    # Generate an LFO (amplitude modulation) to simulate fading (~15 Hz)
    t = np.arange(len(saturated)) / fs
    lfo = 0.8 + 0.2 * np.sin(2 * np.pi * 15.0 * t) 
    # Multiply voice signal with a subtle amount of wideband noise
    modulation_noise = np.random.normal(0, 0.05, len(saturated))
    # Distortion changes based on voice amplitude + fading
    modulated = saturated * lfo + (saturated * modulation_noise)

    print("4. Applying Squelch Envelope (Gating)...")
    # Get envelope of the voice to control the static noise
    env = envelope_follower(saturated, fs, attack_time=0.01, release_time=0.1)
    
    # Normalize envelope to 0.0-1.0
    if np.max(env) > 0:
        env = env / np.max(env)
        
    # Generate white and pink-like noise blend for squelch
    white_noise = np.random.normal(0, 1.0, len(modulated))
    # Simple 1st-order lowpass to get a "pinker" noise character from white noise
    b_pink, a_pink = butter(1, 1000 / (0.5 * fs), btype='low')
    pink_ish_noise = lfilter(b_pink, a_pink, white_noise)
    background_static = (white_noise * 0.3 + pink_ish_noise * 0.7)
    
    # The static is ducked when the voice is loud (env is high),
    # and swells up slightly when voice drops (env is low).
    # We constrain the maximum static so it doesn't just blast continuously.
    background_level = 0.05 # base noise
    ducking_factor = 1.0 - env # 0 when loud, 1 when silent
    
    # Apply gating: We only want squelch when there's general activity, not infinite trailing noise.
    # We will compute a macro-envelope to know when the transmission is "active"
    macro_env = envelope_follower(saturated, fs, attack_time=0.05, release_time=0.5)
    is_transmitting = macro_env > 0.02
    
    # Static noise: only active during transmission. It rises in micro-pauses.
    squelch_noise = background_static * (background_level + 0.15 * ducking_factor) * is_transmitting
    
    final_audio = modulated + squelch_noise

    print("5. Generating Squelch Tail (Tssshk)...")
    # Find the ends of the transmission
    # A drop in 'is_transmitting' from True to False indicates a PTT release
    release_indices = np.where(np.diff(is_transmitting.astype(int)) == -1)[0]
    
    tail_duration = 0.15 # 150ms squelch tail
    tail_samples = int(tail_duration * fs)
    
    # For each detected release, add a burst of noise
    for rel_idx in release_indices:
        end_idx = rel_idx + tail_samples
        if end_idx < len(final_audio):
            # Tail is mostly filtered white noise
            tail_noise = np.random.normal(0, 0.4, tail_samples)
            # Highpass to give it that sharp "tssshk" sound
            b_hp, a_hp = butter(2, 2000 / (0.5 * fs), btype='high')
            tail_noise = lfilter(b_hp, a_hp, tail_noise)
            final_audio[rel_idx:end_idx] += tail_noise

    # Final normalization and hard clipping to ensure valid WAV range
    final_audio = final_audio / np.max(np.abs(final_audio)) * 0.9
    final_audio = np.clip(final_audio, -1.0, 1.0)
    
    # Convert back to 16-bit integer
    output_data = np.int16(final_audio * 32767)
    print(f"Writing {output_file}...")
    wavfile.write(output_file, fs, output_data)
    print("Done! Radio effect applied successfully.")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description='Apply realistic VHF/Walkie-Talkie DSP effect to a WAV file.')
    parser.add_argument('--input', type=str, default='input.wav', help='Path to the input WAV file.')
    parser.add_argument('--output', type=str, default='radio_output.wav', help='Path to the output WAV file.')
    
    args = parser.parse_args()
    process_radio_effect(args.input, args.output)
