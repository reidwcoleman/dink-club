import AVFoundation

/**
 Keeps the paddle running with the screen locked or another app in front: iOS lets an app with a
 live audio session keep executing in the background, so while connected the app plays silence
 (mixed with whatever else is playing, so it never interrupts music). Motion updates and the
 Wi-Fi link carry on.
 */
final class KeepAlive {
    private let engine = AVAudioEngine()
    private var node: AVAudioSourceNode?
    private(set) var on = false

    func start() {
        guard !on else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, options: [.mixWithOthers])
        try? s.setActive(true)
        let fmt = engine.outputNode.inputFormat(forBus: 0)
        let n = AVAudioSourceNode(format: fmt) { _, _, frames, abl in
            let list = UnsafeMutableAudioBufferListPointer(abl)
            for b in list { memset(b.mData, 0, Int(b.mDataByteSize)) }
            _ = frames
            return noErr
        }
        node = n
        engine.attach(n)
        engine.connect(n, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 0
        do { try engine.start(); on = true } catch { on = false }
    }

    func stop() {
        guard on else { return }
        engine.stop()
        if let n = node { engine.detach(n) }
        node = nil
        on = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

/**
 The hit's sound from the phone: a hard plastic ball off a composite paddle is a short, bright
 "pock" — a ~1.2 kHz knock that dies in a few tens of milliseconds over a click of noise. Made
 once in code; played from its own engine, mixed with whatever else is playing.
 */
final class Pock {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var buffer: AVAudioPCMBuffer?
    private var ready = false

    private func setUp() {
        let fmt = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        let n = AVAudioFrameCount(44100 * 0.09)
        guard let b = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: n) else { return }
        b.frameLength = n
        let d = b.floatChannelData![0]
        var seed: UInt32 = 12345
        for i in 0..<Int(n) {
            let t = Double(i) / 44100
            seed = seed &* 1664525 &+ 1013904223
            let noise = Double(Int32(bitPattern: seed)) / Double(Int32.max)
            let knock = sin(2 * .pi * 1180 * t) * 0.7 + sin(2 * .pi * 2650 * t) * 0.25
            let v = knock * exp(-t / 0.018) + noise * exp(-t / 0.004) * 0.5
            d[i] = Float(v * 0.9)
        }
        buffer = b
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        do { try engine.start(); ready = true } catch { ready = false }
    }

    func play(power: Double) {
        if buffer == nil { setUp() }
        guard ready, let b = buffer else { return }
        if !engine.isRunning { try? engine.start() }
        node.volume = Float(0.45 + 0.55 * max(0, min(1, power)))
        node.scheduleBuffer(b, at: nil, options: .interrupts)
        if !node.isPlaying { node.play() }
    }
}
