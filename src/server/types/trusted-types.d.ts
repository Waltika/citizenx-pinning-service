declare module 'trusted-types/lib' {
    interface TrustedTypePolicy {}
    interface TrustedHTML {}
    interface TrustedTypesWindow {
        trustedTypes: any;
    }
}