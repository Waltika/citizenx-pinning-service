import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import {resolve} from 'path';

export default defineConfig({
    plugins: [
        react(),
        svgr({
            svgrOptions: {
                icon: true,
                svgo: true,
                svgoConfig: {
                    plugins: [
                        {
                            name: 'preset-default',
                            params: {
                                overrides: {
                                    removeViewBox: false,
                                },
                            },
                        },
                    ],
                },
            },
            include: '**/*.svg',
        }),
    ],
    resolve: {
        alias: {
            'events': 'events',
        },
    },
    css: {
        modules: {
            localsConvention: 'camelCase',
            scopeBehaviour: 'local'
        },
        preprocessorOptions: {
            scss: {
                additionalData: '@use "sass:math";'
            }
        }
    },
    build: {
        outDir: resolve(process.cwd(), 'dist/web'),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(process.cwd(), 'web/main.tsx'),
            },
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'assets/[name].js',
                assetFileNames: 'assets/[name].[ext]',
            },
            external: ['react', 'react-dom', 'gun', 'gun/sea', 'quill'],
        },
        base: '/view-annotations',
        minify: true,
        chunkSizeWarningLimit: 100,
    },
    optimizeDeps: {
        include: ['gun', 'gun/sea'],
    },
    esbuild: {
        treeShaking: true,
    }
});