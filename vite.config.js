import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // vercel dev 를 쓰지 않고 vite dev 만 쓸 때를 위한 안내용 설정입니다.
      // 로컬에서 API까지 함께 돌리려면 `vercel dev` 를 사용하세요.
    },
  },
});
