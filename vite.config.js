import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, '/');
          if (path.includes('/node_modules/@firebase/auth/')) return 'firebase-auth';
          if (path.includes('/node_modules/@firebase/firestore/')) return 'firebase-firestore';
          if (path.includes('/node_modules/@firebase/storage/')) return 'firebase-storage';
          if (path.includes('/node_modules/@firebase/')) return 'firebase-core';
        },
      },
    },
  },
});
