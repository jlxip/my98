export interface TorrentSources {apis:string[];trackers:string[];webseeds:string[];}
/** Initial background policy defaults to disk; none permits profile-only clients. */
export interface RemoteOptions {publicKey?:string;infoHash?:string;sources?:TorrentSources;prefetchScope?:"none"|"disk";}
export interface DiskState {readOnly:boolean;size:number;disk_id:number[];dirty_bytes:number;dirty_sectors:number;cache_bytes:number;revision:number;}
export interface PreparedDownload {id:number;blob:Blob;size:number;}
export interface SavedDisk extends DiskState {outcome:"created"|"unchanged";download?:PreparedDownload;}
export interface BootRangeProfile {version:1;infoHash:string;unitBytes:65536;ranges:([number,number]|null)[];}
export interface GeneratedBootRangeProfile extends BootRangeProfile {minUtilization:number;observedUnits:number;coveredUnits:number;downloadUnits:number;}
export type LoadOrigin = {kind:"boot"}|{kind:"state";sha256:string};
export interface LoadRangeProfile extends Omit<GeneratedBootRangeProfile,"version"> {version:2;origin:LoadOrigin;}
export interface LoadPrefetchOptions {origin:"boot"|"restored";scope:"none"|"profile"|"disk"|"auto";}
export interface DiskTraceEvent {type:string;unit?:number;time:number;offset?:number;length?:number;ms?:number;}
/** Extract the public identity from a v2 credential, validating its encoding. */
export function readOnlyPublicKey(readKey:string):Uint8Array;
export class Slop86Disk {
 static create(options?:{workerUrl?:URL|string;onProgress?:(progress:{phase:string;completed:number;total:number;readBytes:number;readCalls:number})=>void;onAnalysis?:(event:{type:'analysis';error:string})=>void}):Promise<Slop86Disk>;
 unlock(username:string,password:string,machine:string):Promise<{publicKey:number[]}>;
 relayPublicKey():Promise<Uint8Array>;
 onClosed(listener:()=>void):()=>void;
 signRelayChallenge(challenge:{url:string;origin:string;nonce:Uint8Array;expires:number}):Promise<Uint8Array>;
 createFromImage(file:File|Blob):Promise<SavedDisk>;
 createEmpty(sizeBytes:number):Promise<SavedDisk>;
 open(file:File|Blob):Promise<DiskState>;
 openRemote(options?:RemoteOptions):Promise<DiskState>;
 openRemoteReadOnly(options:RemoteOptions & {readKey:string}):Promise<DiskState>;
 preparePublishedState():Promise<{token:number;metadata:Record<string,unknown>;state:ArrayBuffer;size:number}>;
 /** Export a stable capability for the unlocked identity, including past/future disks. Treat as a secret. */
 exportReadOnlyKey():Promise<string>;
 /** Open an encrypted local file using a my98-ro-v2 capability. Writes stay in RAM. */
 openReadOnly(options:{file:File|Blob;readKey:string}):Promise<DiskState>;
 describe():Promise<DiskState>;
 read(offset:number,length:number):Promise<Uint8Array>;
 write(offset:number,bytes:Uint8Array):Promise<DiskState>;
 save():Promise<SavedDisk>;
 downloadCurrent():Promise<PreparedDownload>;
 retryDownload():Promise<PreparedDownload>;
 verifyImage():Promise<Uint8Array>;
 discardWrites():Promise<DiskState>;
 readStats():Promise<{readBytes:number;readCalls:number;networkBytes:number;networkRequests:number;blockCacheBytes:number;remote?:unknown}>;
 readTrace():Promise<DiskTraceEvent[]>;
 startLoadAnalysis(options:{origin:"boot"|"restored"}):Promise<void>;
 finishLoadAnalysis():Promise<LoadRangeProfile[]>;
 cancelLoadAnalysis():Promise<void>;
 setLoadPrefetch(options:LoadPrefetchOptions):Promise<void>;
 startBootAnalysis():Promise<void>;
 finishBootAnalysis():Promise<GeneratedBootRangeProfile[]>;
 cancelBootAnalysis():Promise<void>;
 resumePrefetch():Promise<void>;
 clearCaches():Promise<void>;
 cancel():void;
 close():Promise<void>;
 terminate():void;
}
export class DiskBuffer {
 constructor(client:Slop86Disk,size:number,onError:(error:Error)=>void|Promise<void>);
 byteLength:number;failed:boolean;
 get(offset:number,length:number,callback:(bytes:Uint8Array)=>void):void;
 set(offset:number,bytes:Uint8Array,callback:()=>void):void;
 retry():Promise<void>;
 dispose():void;
}
