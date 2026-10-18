export interface IdentityHandle {
    handle: number;
    publicKey: Uint8Array;
}
export interface DiskHandle {
    handle: number;
    diskId: Uint8Array;
    descriptor: Uint8Array;
    sha256: string;
}
export interface EncryptedObject {
    bytes: Uint8Array;
    sha256: string;
}
export class Slop86Crypto {
    static create(options?: { workerUrl?: URL | string }): Promise<Slop86Crypto>;
    constructor(workerUrl: URL | string);
    deriveIdentity(username: string, password: string, machine: string): Promise<IdentityHandle>;
    createDisk(identity: number): Promise<DiskHandle>;
    openDisk(identity: number, descriptor: Uint8Array): Promise<DiskHandle>;
    sealUnit(disk: number, unit: bigint, bytes: Uint8Array): Promise<EncryptedObject>;
    openUnit(disk: number, unit: bigint, envelope: Uint8Array): Promise<Uint8Array>;
    sealMetadata(disk: number, bytes: Uint8Array): Promise<EncryptedObject>;
    openMetadata(disk: number, envelope: Uint8Array): Promise<Uint8Array>;
    sign(identity: number, message: Uint8Array): Promise<Uint8Array>;
    relayPublicKey(identity: number): Promise<Uint8Array>;
    signRelayChallenge(identity: number, challenge: {url:string;origin:string;nonce:Uint8Array;expires:number}): Promise<Uint8Array>;
    verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
    hash(bytes: Uint8Array): Promise<string>;
    closeDisk(disk: number): Promise<void>;
    closeIdentity(identity: number): Promise<void>;
    close(): Promise<void>;
    terminate(): void;
}
export function unitId(value: bigint): Uint8Array;
