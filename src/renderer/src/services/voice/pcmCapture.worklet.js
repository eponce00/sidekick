// Runs on the audio thread: collects microphone samples into ~100 ms frames and
// hands them to the page, which forwards them to the local dictation engine.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(1600)
    this.length = 0
  }

  // A worklet is loaded by URL as plain JavaScript, so it cannot carry types.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.frame.length - this.length)
      this.frame.set(channel.subarray(offset, offset + count), this.length)
      this.length += count
      offset += count
      if (this.length === this.frame.length) {
        this.port.postMessage(this.frame)
        this.frame = new Float32Array(1600)
        this.length = 0
      }
    }
    return true
  }
}

registerProcessor('sidekick-pcm-capture', PcmCapture)
