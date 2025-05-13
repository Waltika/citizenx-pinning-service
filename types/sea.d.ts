declare module 'gun/sea.js' {
    interface SEA {
        verify(data: string, publicKey: string): Promise<boolean>;
        // Add other SEA methods as needed
    }
    const SEA: SEA;
    export default SEA;
}