// Realtime voice audio for the Open Session Mac shell.
//
// The Electron main process spawns this signed helper for one voice session.
// It owns the real microphone and speaker through AVAudioEngine in voice
// processing mode (Apple's echo cancellation, noise suppression and other-audio
// ducking), so the remote voice agent hears the person and not itself. The
// renderer never opens a microphone for this path.
//
//   os1-voice-audio devices
//     Prints one JSON line {"inputs":[{"id","label"}],"outputs":[...],
//     "advancedDucking":bool} and exits. `id` is the persistent CoreAudio UID.
//
//   os1-voice-audio stream <inputUID> <outputUID> <ducking 0|1>
//     Empty UIDs mean the system default device. Both stdin and stdout carry
//     binary frames: [type u8][length u32 little-endian][payload].
//       stdin  1 audio    Float32 48 kHz mono PCM to play to the person
//              2 stop     release the microphone and exit
//              3 pause    tear the engine down (microphone, speaker and
//                         ducking released), discard queued playback
//              4 resume   build and start the engine again, re-resolving the
//                         chosen devices; a missing device is an error
//              5 clear    discard queued playback (barge-in)
//       stdout 1 audio    Float32 48 kHz mono PCM from the processed microphone
//              2 event    JSON: {"type":"ready"} once the engine runs, then
//                         {"type":"error","message":...} before exiting.
//     EOF on stdin or a broken stdout pipe also tears everything down, so the
//     shell dying (or killing the child) always releases the hardware.
//
// Realtime bounds: playback is a 250 ms ring buffer that drops its oldest
// audio when the agent runs ahead, and microphone frames are dropped when
// more than 250 ms already waits on the stdout pipe. Nothing here touches the
// disk. The render thread only copies out of the ring (try-lock, never
// blocking); the tap thread converts and hands frames to a writer queue; all
// logging happens on the main thread.

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

let voiceSampleRate: Double = 48_000
let voiceChannels: AVAudioChannelCount = 1

// One inbound audio frame is at most 256 KB (about 1.3 s at 48 kHz mono).
let maxFramePayloadBytes = 256 * 1_024
// Agent audio waiting to be rendered: 250 ms, then the oldest is dropped so
// playback stays at the live edge instead of drifting behind the conversation.
let maxQueuedPlaybackFrames = Int(voiceSampleRate / 4)
// Microphone audio waiting on the stdout pipe: 250 ms, then new frames are
// dropped rather than piling up while the shell is not reading.
let maxPendingOutputBytes = Int(voiceSampleRate / 4) * MemoryLayout<Float>.size

enum InboundFrame: UInt8 {
    case audio = 1
    case stop = 2
    case pause = 3
    case resume = 4
    case clearPlayback = 5
}

enum OutboundFrame: UInt8 {
    case audio = 1
    case event = 2
}

// MARK: - Wire framing

func encodeFrame(type: UInt8, payload: Data) -> Data {
    var frame = Data(capacity: 5 + payload.count)
    frame.append(type)
    var length = UInt32(payload.count).littleEndian
    withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
    frame.append(payload)
    return frame
}

/// Incremental decoder for the [type][u32 length][payload] stream. Oversized
/// frames are a protocol violation and end the stream.
struct FrameDecoder {
    private var buffer = Data()
    private(set) var failed = false

    mutating func feed(_ chunk: Data) -> [(type: UInt8, payload: Data)] {
        guard !failed else { return [] }
        buffer.append(chunk)
        var frames: [(UInt8, Data)] = []
        while buffer.count >= 5 {
            let type = buffer[buffer.startIndex]
            let length = buffer.withUnsafeBytes { bytes in
                UInt32(littleEndian: bytes.loadUnaligned(fromByteOffset: 1, as: UInt32.self))
            }
            guard length <= maxFramePayloadBytes else {
                failed = true
                buffer.removeAll()
                return frames
            }
            let total = 5 + Int(length)
            guard buffer.count >= total else { break }
            let payload = Data(buffer[buffer.startIndex + 5 ..< buffer.startIndex + total])
            frames.append((type, payload))
            buffer.removeFirst(total)
        }
        return frames
    }
}

// MARK: - Devices

struct AudioDevice: Codable, Equatable {
    let id: String
    let label: String
}

struct DeviceList: Codable, Equatable {
    let inputs: [AudioDevice]
    let outputs: [AudioDevice]
    let advancedDucking: Bool
}

var advancedDuckingAvailable: Bool {
    if #available(macOS 14.0, *) { return true }
    return false
}

enum CoreAudioDevices {
    static func string(_ selector: AudioObjectPropertySelector, of device: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
        }
        guard status == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    static func channelCount(of device: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func allDeviceIDs() -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else {
            return []
        }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func list() -> DeviceList {
        var inputs: [AudioDevice] = []
        var outputs: [AudioDevice] = []
        for id in allDeviceIDs() {
            guard let uid = string(kAudioDevicePropertyDeviceUID, of: id), !uid.isEmpty else { continue }
            let label = string(kAudioObjectPropertyName, of: id) ?? uid
            let device = AudioDevice(id: uid, label: label)
            if channelCount(of: id, scope: kAudioObjectPropertyScopeInput) > 0 { inputs.append(device) }
            if channelCount(of: id, scope: kAudioObjectPropertyScopeOutput) > 0 { outputs.append(device) }
        }
        return DeviceList(inputs: inputs, outputs: outputs, advancedDucking: advancedDuckingAvailable)
    }

    /// Resolves a persistent UID to the live device that currently owns it and
    /// has channels in `scope`. Nil when the device is not connected.
    static func device(uid: String, scope: AudioObjectPropertyScope) -> AudioObjectID? {
        for id in allDeviceIDs() where string(kAudioDevicePropertyDeviceUID, of: id) == uid {
            return channelCount(of: id, scope: scope) > 0 ? id : nil
        }
        return nil
    }
}

// MARK: - Microphone conversion

/// Folds any input layout into mono and resamples it to 48 kHz. Kept per
/// engine configuration, because the converter carries resampler state.
final class MonoResampler {
    private let inputFormat: AVAudioFormat
    private let monoInputFormat: AVAudioFormat
    private let converter: AVAudioConverter?
    let outputFormat: AVAudioFormat

    init?(inputFormat: AVAudioFormat) {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let monoInput = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: inputFormat.sampleRate,
                  channels: voiceChannels,
                  interleaved: false
              ),
              let output = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: voiceSampleRate,
                  channels: voiceChannels,
                  interleaved: false
              )
        else { return nil }
        self.inputFormat = inputFormat
        monoInputFormat = monoInput
        outputFormat = output
        if inputFormat.sampleRate == voiceSampleRate {
            converter = nil
        } else {
            guard let converter = AVAudioConverter(from: monoInput, to: output) else { return nil }
            self.converter = converter
        }
    }

    /// Returns little-endian Float32 mono samples at 48 kHz.
    func convert(_ buffer: AVAudioPCMBuffer) -> Data {
        guard let mono = foldToMono(buffer), mono.frameLength > 0 else { return Data() }
        guard let converter else { return pcmData(mono) }
        let ratio = voiceSampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(mono.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return Data()
        }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return mono
        }
        guard status != .error, error == nil else { return Data() }
        return pcmData(output)
    }

    private func foldToMono(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return nil }
        if buffer.format.channelCount == 1, buffer.format.commonFormat == .pcmFormatFloat32,
           !buffer.format.isInterleaved
        {
            return buffer
        }
        guard let source = buffer.floatChannelData,
              let mono = AVAudioPCMBuffer(pcmFormat: monoInputFormat, frameCapacity: AVAudioFrameCount(frames)),
              let target = mono.floatChannelData?[0]
        else { return nil }
        mono.frameLength = AVAudioFrameCount(frames)
        let channels = Int(buffer.format.channelCount)
        let stride = Int(buffer.stride)
        let scale = 1 / Float(channels)
        for frame in 0 ..< frames {
            var sum: Float = 0
            for channel in 0 ..< channels {
                sum += buffer.format.isInterleaved
                    ? source[0][frame * stride + channel]
                    : source[channel][frame]
            }
            target[frame] = sum * scale
        }
        return mono
    }

    private func pcmData(_ buffer: AVAudioPCMBuffer) -> Data {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return Data() }
        return Data(bytes: channel, count: Int(buffer.frameLength) * MemoryLayout<Float>.size)
    }
}

// MARK: - Playback ring

/// Single-producer, single-consumer ring of agent audio. The main thread
/// writes under a lock; the render thread only ever try-locks, so it never
/// blocks (a contended render cycle plays silence). When the agent runs ahead
/// of realtime the oldest audio is dropped, keeping playback at the live edge.
final class PlaybackRing {
    private let lock = NSLock()
    private let capacity: Int
    private let storage: UnsafeMutablePointer<Float>
    private var head = 0
    private var count = 0
    private var dropped = 0

    init(capacity: Int) {
        self.capacity = max(capacity, 1)
        storage = .allocate(capacity: self.capacity)
        storage.initialize(repeating: 0, count: self.capacity)
    }

    deinit {
        storage.deallocate()
    }

    var queuedFrames: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    /// Frames discarded so far because the ring was full. Read from the main
    /// thread for diagnostics.
    var droppedFrames: Int {
        lock.lock()
        defer { lock.unlock() }
        return dropped
    }

    /// Returns how many of the oldest frames were dropped to make room.
    @discardableResult
    func write(_ samples: UnsafeBufferPointer<Float>) -> Int {
        guard let source = samples.baseAddress, samples.count > 0 else { return 0 }
        lock.lock()
        defer { lock.unlock() }
        var offset = 0
        var frames = samples.count
        if frames > capacity {
            offset = frames - capacity
            frames = capacity
        }
        var overflow = offset
        if count + frames > capacity {
            let excess = count + frames - capacity
            head = (head + excess) % capacity
            count -= excess
            overflow += excess
        }
        var tail = (head + count) % capacity
        var remaining = frames
        var cursor = offset
        while remaining > 0 {
            let run = min(remaining, capacity - tail)
            (storage + tail).update(from: source + cursor, count: run)
            tail = (tail + run) % capacity
            cursor += run
            remaining -= run
        }
        count += frames
        dropped += overflow
        return overflow
    }

    /// Fills `target` with the oldest queued audio, zero-padding when the ring
    /// runs dry or the lock is held. Safe on the real-time render thread.
    func read(into target: UnsafeMutablePointer<Float>, frames: Int) {
        guard frames > 0 else { return }
        guard lock.try() else {
            target.update(repeating: 0, count: frames)
            return
        }
        defer { lock.unlock() }
        let available = min(count, frames)
        var remaining = available
        var cursor = 0
        while remaining > 0 {
            let run = min(remaining, capacity - head)
            (target + cursor).update(from: storage + head, count: run)
            head = (head + run) % capacity
            cursor += run
            remaining -= run
        }
        count -= available
        if available < frames {
            (target + available).update(repeating: 0, count: frames - available)
        }
    }

    func clear() {
        lock.lock()
        head = 0
        count = 0
        lock.unlock()
    }
}

// MARK: - Output

/// Serializes writes to stdout off the audio threads. Microphone frames are
/// dropped once too much waits on the pipe; events are never dropped. Nothing
/// is logged from here: callers on the main thread read `droppedFrames`.
final class OutputWriter {
    private let queue = DispatchQueue(label: "os1.voice.output")
    private let lock = NSLock()
    private var pendingBytes = 0
    private var dropped = 0
    var onBrokenPipe: (() -> Void)?

    var droppedFrames: Int {
        lock.lock()
        defer { lock.unlock() }
        return dropped
    }

    func send(_ type: OutboundFrame, _ payload: Data) {
        let frame = encodeFrame(type: type.rawValue, payload: payload)
        lock.lock()
        if type == .audio, pendingBytes > maxPendingOutputBytes {
            dropped += 1
            lock.unlock()
            return
        }
        pendingBytes += frame.count
        lock.unlock()
        queue.async { [self] in
            let written = frame.withUnsafeBytes { bytes -> Bool in
                var offset = 0
                while offset < bytes.count {
                    let result = write(STDOUT_FILENO, bytes.baseAddress! + offset, bytes.count - offset)
                    if result < 0 {
                        if errno == EINTR { continue }
                        return false
                    }
                    offset += result
                }
                return true
            }
            lock.lock()
            pendingBytes -= frame.count
            lock.unlock()
            if !written { onBrokenPipe?() }
        }
    }

    func event(_ type: String, message: String? = nil) {
        var payload = ["type": type]
        if let message { payload["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        send(.event, data)
    }

    /// Waits briefly for queued writes. Bounded, because a shell that stopped
    /// reading must not keep this process (and the microphone) alive; the
    /// shell escalates to SIGKILL for the same reason.
    func flush(timeout: TimeInterval = 0.5) {
        let done = DispatchSemaphore(value: 0)
        queue.async { done.signal() }
        _ = done.wait(timeout: .now() + timeout)
    }
}

// MARK: - Engine

struct VoiceConfiguration {
    let inputUID: String
    let outputUID: String
    let ducking: Bool
}

enum VoiceError: LocalizedError {
    case microphoneDenied
    case inputMissing(String)
    case outputMissing(String)
    case deviceRejected(String, OSStatus)
    case deviceNotApplied(String)
    case engine(String)

    var errorDescription: String? {
        switch self {
        case .microphoneDenied: return "microphone access is denied"
        case let .inputMissing(uid): return "input device is not connected: \(uid)"
        case let .outputMissing(uid): return "output device is not connected: \(uid)"
        case let .deviceRejected(role, status): return "\(role) device was rejected by voice processing (\(status))"
        case let .deviceNotApplied(role): return "\(role) device selection did not take effect"
        case let .engine(message): return message
        }
    }
}

/// One voice-processing AVAudioEngine: processed microphone out, agent audio
/// in. `pause()` tears the engine down completely so the microphone and the
/// ducking policy are released; `resume()` builds a fresh one and re-resolves
/// the chosen devices, so a device that went away while paused is an error
/// rather than a silent fallback to whatever macOS picks.
final class VoiceEngine {
    private let configuration: VoiceConfiguration
    private let writer: OutputWriter
    private var engine: AVAudioEngine?
    private var source: AVAudioSourceNode?
    private var ring: PlaybackRing?
    private var tapInstalled = false
    private var observer: NSObjectProtocol?
    private var restartAttempts: [Date] = []
    private(set) var running = false
    private(set) var paused = false
    var onFailure: ((String) -> Void)?

    init(configuration: VoiceConfiguration, writer: OutputWriter) {
        self.configuration = configuration
        self.writer = writer
    }

    func start() throws {
        try build()
        try run()
    }

    func pause() {
        paused = true
        stop()
    }

    func resume() throws {
        guard paused else { return }
        paused = false
        try build()
        try run()
    }

    func stop() {
        running = false
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0) }
        tapInstalled = false
        engine?.stop()
        if let engine, let source { engine.detach(source) }
        engine = nil
        source = nil
        ring = nil
    }

    var droppedPlaybackFrames: Int { ring?.droppedFrames ?? 0 }

    func play(_ data: Data) {
        guard running, let ring else { return }
        let frames = data.count / MemoryLayout<Float>.size
        guard frames > 0 else { return }
        // Pipe payloads may be unaligned, so go through a Float copy.
        let samples = [Float](unsafeUninitializedCapacity: frames) { target, initialized in
            data.withUnsafeBytes { bytes in
                UnsafeMutableRawBufferPointer(target).copyMemory(
                    from: UnsafeRawBufferPointer(rebasing: bytes.prefix(frames * MemoryLayout<Float>.size))
                )
            }
            initialized = frames
        }
        samples.withUnsafeBufferPointer { _ = ring.write($0) }
    }

    func clearPlayback() {
        ring?.clear()
    }

    // Wires a fresh engine: voice processing first (it swaps the I/O unit, so
    // any device set earlier would be lost), then the per-engine devices with
    // read-back, the ducking policy, playback and the microphone tap.
    //
    // The main mixer must exist before voice processing is enabled. Created
    // afterwards, its implicit connection to the output node picks up the
    // voice-processing unit's unset (0 channel, 0 Hz) output format and
    // start() fails initializing the output node with -10875
    // (kAudioUnitErr_FailedInitialization).
    private func build() throws {
        stop()
        let engine = AVAudioEngine()
        _ = engine.mainMixerNode
        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            throw VoiceError.engine("voice processing is unavailable: \(error.localizedDescription)")
        }
        try selectDevices(on: input)
        if #available(macOS 14.0, *) {
            input.voiceProcessingOtherAudioDuckingConfiguration = configuration.ducking
                ? AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: true, duckingLevel: .max)
                : AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }

        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: voiceSampleRate,
            channels: voiceChannels,
            interleaved: false
        ) else { throw VoiceError.engine("48 kHz mono format is unavailable") }
        let ring = PlaybackRing(capacity: maxQueuedPlaybackFrames)
        let source = AVAudioSourceNode(format: format) { _, _, frameCount, audioBufferList -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
            guard let first = buffers.first, let data = first.mData else { return noErr }
            let frames = Int(frameCount)
            ring.read(into: data.assumingMemoryBound(to: Float.self), frames: frames)
            for extra in buffers.dropFirst() {
                if let target = extra.mData {
                    target.copyMemory(from: data, byteCount: frames * MemoryLayout<Float>.size)
                }
            }
            return noErr
        }
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: format)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)

        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let resampler = MonoResampler(inputFormat: inputFormat)
        else { throw VoiceError.engine("microphone format is unavailable") }

        self.engine = engine
        self.source = source
        self.ring = ring
        // The tap runs on an audio thread and touches nothing mutable on this
        // object: it owns its converter for the life of this engine and the
        // writer is shared and thread-safe. Frames from a tap that fires around
        // a rebuild are harmless; the shell discards audio before ready and
        // after stop.
        let writer = self.writer
        input.installTap(onBus: 0, bufferSize: 960, format: inputFormat) { buffer, _ in
            let data = resampler.convert(buffer)
            if !data.isEmpty { writer.send(.audio, data) }
        }
        tapInstalled = true
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in self?.configurationChanged() }
    }

    private func run() throws {
        guard let engine else { throw VoiceError.engine("engine is not built") }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            throw VoiceError.engine("audio engine could not start: \(error.localizedDescription)")
        }
        running = true
    }

    // Element 0 is the output side of the voice-processing I/O unit and
    // element 1 the input side. Each is set only when a device was asked for,
    // otherwise the unit follows the system defaults. Every selection is read
    // back: an accepted property write that did not stick is still a failure.
    private func selectDevices(on input: AVAudioInputNode) throws {
        guard let unit = input.audioUnit else { throw VoiceError.engine("voice processing unit is unavailable") }
        if !configuration.outputUID.isEmpty {
            guard let device = CoreAudioDevices.device(uid: configuration.outputUID, scope: kAudioObjectPropertyScopeOutput)
            else { throw VoiceError.outputMissing(configuration.outputUID) }
            try set(device: device, element: 0, role: "output", on: unit)
        }
        if !configuration.inputUID.isEmpty {
            guard let device = CoreAudioDevices.device(uid: configuration.inputUID, scope: kAudioObjectPropertyScopeInput)
            else { throw VoiceError.inputMissing(configuration.inputUID) }
            try set(device: device, element: 1, role: "input", on: unit)
        }
    }

    private func set(device: AudioObjectID, element: AudioUnitElement, role: String, on unit: AudioUnit) throws {
        var id = device
        let size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &id, size
        )
        guard status == noErr else { throw VoiceError.deviceRejected(role, status) }
        var applied = AudioObjectID(0)
        var appliedSize = size
        let readback = AudioUnitGetProperty(
            unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &applied, &appliedSize
        )
        guard readback == noErr, applied == device else { throw VoiceError.deviceNotApplied(role) }
    }

    // A device that appears or disappears (AirPods, a dock) stops the engine.
    // Rebuild so a session survives it, which re-resolves the chosen devices
    // and fails if one is gone; give up when it keeps happening.
    private func configurationChanged() {
        guard running, !paused else { return }
        let now = Date()
        restartAttempts = restartAttempts.filter { now.timeIntervalSince($0) < 10 }
        restartAttempts.append(now)
        guard restartAttempts.count <= 3 else {
            onFailure?("audio device configuration keeps changing")
            return
        }
        do {
            try build()
            try run()
        } catch {
            onFailure?(error.localizedDescription)
        }
    }
}

// MARK: - Process

final class VoiceHelper {
    private let configuration: VoiceConfiguration
    private let writer = OutputWriter()
    private var engine: VoiceEngine?
    private var finished = false
    private var signals: [DispatchSourceSignal] = []
    private var reportedDrops = (playback: 0, microphone: 0)
    private var dropReport: DispatchSourceTimer?

    init(configuration: VoiceConfiguration) {
        self.configuration = configuration
    }

    func start() {
        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            signals.append(source)
        }
        writer.onBrokenPipe = { [weak self] in
            DispatchQueue.main.async { self?.finish() }
        }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            startEngine()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted { self.startEngine() } else { self.fail(VoiceError.microphoneDenied.localizedDescription) }
                }
            }
        default:
            fail(VoiceError.microphoneDenied.localizedDescription)
        }
    }

    private func startEngine() {
        let engine = VoiceEngine(configuration: configuration, writer: writer)
        engine.onFailure = { [weak self] message in self?.fail(message) }
        do {
            try engine.start()
        } catch {
            fail(error.localizedDescription)
            return
        }
        self.engine = engine
        writer.event("ready")
        readInput()
        // Drop counters are read and logged here, on the main thread, never on
        // the audio threads that increment them.
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in self?.reportDrops() }
        timer.resume()
        dropReport = timer
    }

    private func reportDrops() {
        guard let engine else { return }
        let playback = engine.droppedPlaybackFrames
        let microphone = writer.droppedFrames
        if playback != reportedDrops.playback || microphone != reportedDrops.microphone {
            reportedDrops = (playback, microphone)
            FileHandle.standardError.write(Data(
                "voice-audio: dropped \(playback) playback frames (agent ahead of realtime), \(microphone) microphone frames (shell behind)\n".utf8
            ))
        }
    }

    // Reads stdin on its own thread and hands each chunk to the main thread
    // synchronously: the reader cannot run ahead of processing, so nothing
    // accumulates between the pipe and the bounded playback ring.
    private func readInput() {
        let thread = Thread { [weak self] in
            let input = FileHandle.standardInput
            var decoder = FrameDecoder()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { break }
                let frames = decoder.feed(chunk)
                var stop = false
                DispatchQueue.main.sync {
                    guard let self, !self.finished else {
                        stop = true
                        return
                    }
                    if !frames.isEmpty { self.handle(frames) }
                    if decoder.failed { self.fail("audio frame was too large") }
                    stop = self.finished
                }
                if stop { return }
            }
            DispatchQueue.main.async { self?.finish() }
        }
        thread.name = "os1.voice.input"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private func handle(_ frames: [(type: UInt8, payload: Data)]) {
        guard !finished, let engine else { return }
        for frame in frames {
            guard let command = InboundFrame(rawValue: frame.type) else { continue }
            switch command {
            case .audio:
                engine.play(frame.payload)
            case .stop:
                finish()
                return
            case .pause:
                engine.pause()
            case .resume:
                do {
                    try engine.resume()
                } catch {
                    fail(error.localizedDescription)
                    return
                }
            case .clearPlayback:
                engine.clearPlayback()
            }
        }
    }

    private func fail(_ message: String) {
        guard !finished else { return }
        writer.event("error", message: message)
        finish(exitCode: 1)
    }

    private func finish(exitCode: Int32 = 0) {
        guard !finished else { return }
        finished = true
        dropReport?.cancel()
        // Hardware first: the microphone and ducking are released before any
        // attempt to drain stdout.
        engine?.stop()
        engine = nil
        writer.flush()
        exit(exitCode)
    }
}

#if !VOICE_AUDIO_TESTING
@main
private enum Main {
    static func main() {
        let arguments = CommandLine.arguments
        if arguments.count == 2, arguments[1] == "devices" {
            guard let data = try? JSONEncoder().encode(CoreAudioDevices.list()) else { exit(1) }
            FileHandle.standardOutput.write(data + Data("\n".utf8))
            exit(0)
        }
        guard arguments.count == 5, arguments[1] == "stream",
              arguments[2].utf8.count <= 256, arguments[3].utf8.count <= 256,
              ["0", "1"].contains(arguments[4])
        else {
            exit(2)
        }
        let helper = VoiceHelper(configuration: VoiceConfiguration(
            inputUID: arguments[2],
            outputUID: arguments[3],
            ducking: arguments[4] == "1"
        ))
        helper.start()
        RunLoop.main.run()
    }
}
#endif
