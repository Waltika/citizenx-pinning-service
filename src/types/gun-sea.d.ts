declare module 'gun/sea.js' {
    interface SEA {
        verify(data: string, publicKey: string): Promise<boolean>;
    }
    const SEA: SEA;
    export default SEA;
}