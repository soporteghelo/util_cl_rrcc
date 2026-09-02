import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // `vercel dev` sirve las funciones de /api en el 3000; en desarrollo
    // normal (`npm run dev`) se redirigen hacia alli.
    proxy: {
      "/api": {
        target: process.env.API_TARGET || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2020",
  },
});
