export function runTransformTask(task, payload) {
  switch (task) {
    case "base64-encode":
      return { output: encodeUtf8ToBase64(payload.source) };
    case "base64-decode":
      return { output: decodeBase64ToUtf8(payload.source) };
    case "json-format": {
      const data = parseJson(payload.source);
      return { data, output: JSON.stringify(data, null, payload.indent) };
    }
    case "json-minify": {
      const data = parseJson(payload.source);
      return { data, output: JSON.stringify(data) };
    }
    case "json-validate":
      return { data: parseJson(payload.source), valid: true };
    default:
      throw new Error("未知操作。");
  }
}

function encodeUtf8ToBase64(source) {
  const bytes = new TextEncoder().encode(source);
  return btoa(bytesToBinary(bytes));
}

function decodeBase64ToUtf8(source) {
  try {
    const binary = atob(source.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Base64 内容无效或不是 UTF-8 文本。");
  }
}

function bytesToBinary(bytes) {
  const chunkSize = 0x8000;
  const chunks = [];

  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize)));
  }

  return chunks.join("");
}

function parseJson(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(getJsonErrorMessage(source, error));
  }
}

function getJsonErrorMessage(source, error) {
  const message = error.message || "JSON 无效。";
  const match = message.match(/position (\d+)/i);

  if (!match) {
    return `JSON 无效：${message}`;
  }

  const position = Number(match[1]);
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");

  return `JSON 无效：第 ${line} 行，第 ${column} 列附近。`;
}
