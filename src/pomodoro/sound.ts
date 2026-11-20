// 倒计时结束提示音:用 WebAudio 直接合成,不引入音频资源文件。
export function chime(times = 3) {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const start = ctx.currentTime
    for (let i = 0; i < times; i += 1) {
      const at = start + i * 0.26
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(i === times - 1 ? 880 : 660, at)
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.24)
    }
    window.setTimeout(() => {
      void ctx.close().catch(() => {})
    }, times * 260 + 400)
  } catch {
    /* 无音频设备时静默降级 */
  }
}
