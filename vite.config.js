import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, 'src');

export default defineConfig({
    root: srcRoot,
    base: './',
    build: {
        outDir: resolve(__dirname, 'dist'),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: resolve(srcRoot, 'index.html')
            },
            output: {
                entryFileNames: 'assets/[name]-[hash].js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]'
            }
        }
    },
    server: {
        host: '127.0.0.1',
        port: 15321,
        strictPort: true
    }
});
