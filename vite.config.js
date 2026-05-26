import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    cssCodeSplit: false,
    reportCompressedSize: false,
    sourcemap: false,
    target: "es2020",
  },
});
