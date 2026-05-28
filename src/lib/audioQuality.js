import lameSource from "lamejs/lame.all.js?raw";

const MP3_BITRATE_PRESETS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
let lameRuntime = null;

export async function convertAudioQuality(file, options) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  let decoded;

  try {
    decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioContext.close();
  }

  const targetSampleRate = resolveTargetSampleRate(options.sampleRate, decoded.sampleRate);
  const audioBuffer = await resampleAudio(decoded, targetSampleRate);
  const format = options.format === "wav" ? "wav" : "mp3";
  const bitrate = resolveBitrate(options.bitrate, options.size, audioBuffer.duration, format);

  if (format === "wav") {
    const blob = encodeWav(audioBuffer);
    return buildResult(file, blob, "wav", targetSampleRate, bitrate, audioBuffer.duration);
  }

  const blob = encodeMp3(audioBuffer, bitrate);
  return buildResult(file, blob, "mp3", targetSampleRate, bitrate, audioBuffer.duration);
}

function resolveTargetSampleRate(setting, fallback) {
  const value = Number(setting?.value);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(8000, Math.min(192000, Math.round(value * 1000)));
}

function resolveBitrate(setting, sizeSetting, duration, format) {
  if (format === "wav") return 0;

  const requested = clampBitrate(Number(setting?.value) || 320);
  const sizeLimit = Number(sizeSetting?.value);

  if (sizeSetting?.operator === "lt" && Number.isFinite(sizeLimit) && sizeLimit > 0 && duration > 0) {
    const maxBySize = Math.floor((sizeLimit * 1024 * 1024 * 8) / duration / 1000);
    return clampBitrate(Math.min(requested, maxBySize));
  }

  return requested;
}

function clampBitrate(value) {
  const normalized = Math.max(32, Math.min(320, Math.round(value)));
  return MP3_BITRATE_PRESETS.reduce((best, current) => (Math.abs(current - normalized) < Math.abs(best - normalized) ? current : best), 320);
}

async function resampleAudio(sourceBuffer, sampleRate) {
  if (sourceBuffer.sampleRate === sampleRate) return sourceBuffer;

  const offlineContext = new OfflineAudioContext(
    sourceBuffer.numberOfChannels,
    Math.ceil(sourceBuffer.duration * sampleRate),
    sampleRate,
  );
  const source = offlineContext.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(offlineContext.destination);
  source.start(0);
  return offlineContext.startRendering();
}

function encodeMp3(audioBuffer, bitrate) {
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const { Mp3Encoder } = getLameRuntime();
  const encoder = new Mp3Encoder(channels, audioBuffer.sampleRate, bitrate);
  const samples = [];
  const blockSize = 1152;
  const left = floatToInt16(audioBuffer.getChannelData(0));
  const right = channels > 1 ? floatToInt16(audioBuffer.getChannelData(1)) : null;

  for (let index = 0; index < left.length; index += blockSize) {
    const leftChunk = left.subarray(index, index + blockSize);
    const encoded = right
      ? encoder.encodeBuffer(leftChunk, right.subarray(index, index + blockSize))
      : encoder.encodeBuffer(leftChunk);

    if (encoded.length) samples.push(encoded);
  }

  const end = encoder.flush();
  if (end.length) samples.push(end);
  return new Blob(samples, { type: "audio/mpeg" });
}

function getLameRuntime() {
  if (!lameRuntime) {
    lameRuntime = Function(`${lameSource}; return lamejs;`)();
  }

  return lameRuntime;
}

function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * channels * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);
  let offset = 0;

  writeString(view, offset, "RIFF");
  offset += 4;
  view.setUint32(offset, 36 + length, true);
  offset += 4;
  writeString(view, offset, "WAVE");
  offset += 4;
  writeString(view, offset, "fmt ");
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * channels * 2, true);
  offset += 4;
  view.setUint16(offset, channels * 2, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString(view, offset, "data");
  offset += 4;
  view.setUint32(offset, length, true);
  offset += 4;

  for (let sample = 0; sample < audioBuffer.length; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[sample]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function floatToInt16(channelData) {
  const result = new Int16Array(channelData.length);
  for (let index = 0; index < channelData.length; index += 1) {
    const value = Math.max(-1, Math.min(1, channelData[index]));
    result[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return result;
}

function writeString(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function buildResult(file, blob, format, sampleRate, bitrate, duration) {
  return {
    blob,
    name: getAudioOutputName(file.name, format),
    originalBytes: file.size,
    outputBytes: blob.size,
    format,
    sampleRate,
    bitrate,
    duration,
  };
}

function getAudioOutputName(name, format) {
  const rawName = String(name || "audio").replace(/[\\/:*?"<>|]/g, "_");
  const baseName = rawName.replace(/\.[^.]+$/, "") || "audio";
  return `${baseName}-quality.${format}`;
}
