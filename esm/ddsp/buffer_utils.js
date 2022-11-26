import * as Tone from "tone";
export const arrayBufferToAudioBuffer = (audioCtx, arrayBuffer, sampleRate) => {
    const newBuffer = Tone.context.createBuffer(1, arrayBuffer.length, sampleRate);
    newBuffer.copyToChannel(arrayBuffer, 0);
    return newBuffer;
};
export const sliceAudioBuffer = (audioCtx, audioBuffer, start = 0, end = audioBuffer.length, sampleRate) => {
    const newBuffer = Tone.context.createBuffer(audioBuffer.numberOfChannels, end - start, sampleRate);
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
        newBuffer.copyToChannel(audioBuffer.getChannelData(i).slice(start, end), i);
    }
    return newBuffer;
};
//# sourceMappingURL=buffer_utils.js.map