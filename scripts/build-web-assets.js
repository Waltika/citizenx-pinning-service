import { execSync } from 'child_process';
import { cpSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Absolute path to CitizenX project
const citizenXBasePath = '/Users/walterwartenweiler/CitizenX';

console.log('Building CitizenX web version...');
execSync(`cd ${citizenXBasePath} && npm run build:web`, { stdio: 'inherit' });

console.log('Copying web assets to public/view-annotations...');
cpSync(
    resolve(citizenXBasePath, 'dist/web'),
    resolve(__dirname, '../public/view-annotations'),
    { recursive: true }
);
console.log('Web assets copied successfully.');