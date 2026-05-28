import { runTransformTask } from "../lib/transform.js";
import { compressImageFile } from "../lib/imageCompress.js";

self.addEventListener("message", async (event) => {
  const { id, task, payload } = event.data;

  try {
    const result = task === "image-compress"
      ? await compressImageFile(payload.file, payload.options)
      : runTransformTask(task, payload);

    self.postMessage({
      id,
      ok: true,
      result,
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error.message || "处理失败。",
    });
  }
});
