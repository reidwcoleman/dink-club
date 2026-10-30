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
