import {defineConfig} from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    plugins: [tsconfigPaths()],
    build: {
        outDir: 'dist/server',
        emptyOutDir: true,
        lib: {
            entry: 'src/server/gun-server.ts',
            formats: ['es'],
            fileName: 'gun-server',
        },
        rollupOptions: {
            external: [
                'gun',
                'express',
                'cors',
                'fs',
                'axios',
                'express-rate-limit',
                'dompurify',
                'jsdom',
                'cheerio',
                'gun/sea.js',
                'crypto'
            ],
            output: {
                globals: {
                    gun: 'Gun',
                    express: 'express',
                    cors: 'cors',
                    fs: 'fs',
                    axios: 'axios',
                    'express-rate-limit': 'RateLimit',
                    dompurify: 'DOMPurify',
                    jsdom: 'JSDOM',
                    cheerio: 'cheerio',
                    'gun/sea.js': 'SEA',
                    crypto: 'crypto'
                },
            },
        },
        minify: false,
        target: 'esnext',
        ssr: true // Ensure Node.js environment for SSR
    },
    ssr: {
        noExternal: ['http'] // Include Node.js built-in http module
    }
});