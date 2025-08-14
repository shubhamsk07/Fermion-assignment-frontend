import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(),tailwindcss()],
 server: {
    https:{
      key:'D:/assignment/media1/frontend/keys/localhost+2-key.pem',
      cert:'D:/assignment/media1/frontend/keys/localhost+2.pem',
    },
    host: true,

  },
})
