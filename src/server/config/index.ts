export const baseDataDir: string = process.env.DATA_DIR || '/var/data';
export const dataDir: string = `${baseDataDir}/gun-data`;
export const sitemapPath = `${baseDataDir}/sitemap.xml`;
export const publicUrl: string = 'https://service.citizenx.app';
export const websiteUrl: string = 'https://citizenx.app';
export const initialPeers: string[] = [
    'https://service.citizenx.app/gun',
    'https://s3.citizenx.app/gun',
    'https://s2.citizenx.app/gun'
];
