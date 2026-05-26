import { runTransformTask } from "../lib/transform.js";

self.addEventListener("message", (event) => {
  const { id, task, payload } = event.data;

  try {
    self.postMessage({
      id,
      ok: true,
      result: runTransformTask(task, payload),
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error.message || "处理失败。",
    });
  }
});
