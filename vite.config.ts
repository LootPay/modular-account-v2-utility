import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "./", // important for relative paths
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile(), // 👈 this will inline everything into index.html
  ],
  build: {
    target: "esnext",
    cssCodeSplit: false, // 👈 inline all CSS
    assetsInlineLimit: Infinity, // 👈 inline images/fonts as base64
  },
});
