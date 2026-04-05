import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: "ui",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "ui/dashboard.html",
    },
  },
  plugins: [viteSingleFile()],
});
