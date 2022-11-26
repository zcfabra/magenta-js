export declare function addReverb({ audioCtx, arrayBuffer, sampleRate, }: {
    audioCtx: AudioContext | null;
    arrayBuffer: Float32Array;
    sampleRate: number;
}): Promise<Float32Array>;
