export interface TorrentSources {gateways:string[];trackers:string[];}
/** Initial background policy defaults to disk; none permits profile-only clients. */
export interface RemoteOptions {publicKey?:string;infoHash?:string;sources?:TorrentSources;prefetchScope?:"none"|"disk";waitForFinal?:boolean;}
export interface RemoteDisk {infoHash:string;publicationInfoHash:string;publicKey:string;sequence:string|null;following:boolean;sourceId:string;stateInfoHash:string|null;profileInfoHash:string|null;}
export interface DiskState {remote?:RemoteDisk;readOnly:boolean;size:number;disk_id:number[];dirty_bytes:number;dirty_sectors:number;cache_bytes:number;revision:number;}
export interface PublishingStatus {active:boolean;state:"preparing"|"announcing"|"seeding"|"unconfirmed"|"stopped";seedError?:{code:string;message:string};replicas?:{complete:number;fraction:number;connected:number;unavailable:number;label:string};sequence?:string;magnet?:string;catalogMagnet?:string;error?:{code:string;message:string};}
export interface PublishDiskOptions {kind?:"current"|"encrypted"|"raw";file?:File|Blob;sources:TorrentSources;}
export interface PreparedDownload {id:number;blob:Blob;size:number;}
export interface SavedDisk extends DiskState {outcome:"created"|"unchanged";download?:PreparedDownload;}
export interface BootRangeProfile {version:1;infoHash:string;unitBytes:65536;ranges:([number,number]|null)[];}
export interface GeneratedBootRangeProfile extends BootRangeProfile {minUtilization:number;observedUnits:number;coveredUnits:number;downloadUnits:number;}
export type LoadOrigin = {kind:"boot"}|{kind:"state";sha256:string};
export interface LoadRangeProfile extends Omit<GeneratedBootRangeProfile,"version"> {version:2;origin:LoadOrigin;}
export interface LoadPrefetchOptions {origin:"boot"|"restored";scope:"none"|"profile"|"disk"|"auto";}
/** Opt-in loading barrier; omitted options retain the normal background policy. */
export interface StartupPrefetchOptions {scope:"profile";maxAttempts?:number;postRestoreBudgetMs?:number;windowPieces?:number;}
export interface PreparedState {token:number;metadata:Record<string,unknown>;state:ArrayBuffer;size:number;prefetchId?:string;}
export interface StartupPrefetchResult {outcome:"complete"|"fallback";reason?:string;attempts:number;}
export interface DiskTraceEvent {type:string;unit?:number;time:number;offset?:number;length?:number;ms?:number;}
/** Extract the public identity from a v2 credential, validating its encoding. */
export function readOnlyPublicKey(readKey:string):Uint8Array;
export class Slop86Disk {
 static create(options?:{workerUrl?:URL|string;onProgress?:(progress:{phase:string;completed:number;total:number;readBytes:number;readCalls:number})=>void;onAnalysis?:(event:{type:'analysis';error:string})=>void;onPublishing?:(event:PublishingStatus)=>void;onPublication?:(event:{state:"fixed"|"checking"|"complete"|"unavailable"|"conflict";sequence:string|null;selectedSequence:string|null;infoHash?:string|null;selectedInfoHash?:string|null;sourceId?:string|null;fatal?:boolean;error?:{code:string;message:string}})=>void}):Promise<Slop86Disk>;
 unlock(username:string,password:string,machine:string):Promise<{publicKey:number[]}>;
 relayPublicKey():Promise<Uint8Array>;
 onClosed(listener:()=>void):()=>void;
 signRelayChallenge(challenge:{url:string;origin:string;nonce:Uint8Array;expires:number}):Promise<Uint8Array>;
 createFromImage(file:File|Blob):Promise<SavedDisk>;
 createEmpty(sizeBytes:number):Promise<SavedDisk>;
 open(file:File|Blob):Promise<DiskState>;
 openRemote(options?:RemoteOptions):Promise<DiskState>;
 openRemoteReadOnly(options:RemoteOptions & {readKey:string}):Promise<DiskState>;
 preparePublishedState(options?:{prefetch?:StartupPrefetchOptions}):Promise<PreparedState>;
 prepareState(input:string|File|Blob|{publication:true;prefetch?:StartupPrefetchOptions}):Promise<PreparedState>;
 commitState(token:number):Promise<DiskState>;
 discardState(token:number):Promise<void>;
 waitLoadPrefetch(id:string):Promise<StartupPrefetchResult>;
 /** Export a stable capability for the unlocked identity, including past/future disks. Treat as a secret. */
 exportReadOnlyKey():Promise<string>;
 /** Open an encrypted local file using a my98-ro-v2 capability. Writes stay in RAM. */
 openReadOnly(options:{file:File|Blob;readKey:string}):Promise<DiskState>;
 cancelRemoteUpdate():void;
 prepareRemoteUpdate(options?:{minimumSequence?:string;automatic?:boolean}):Promise<{token?:number;description?:DiskState;unchanged?:boolean;changed?:boolean;sequence?:string;infoHash?:string}>;
 commitRemoteUpdate(token:number,options?:{discardChanges?:boolean}):Promise<DiskState>;
 discardRemoteUpdate(token:number):Promise<void>;
 remoteUpdateDisk(token:number):{committed:boolean;read(offset:number,length:number):Promise<Uint8Array>;write(offset:number,bytes:Uint8Array):Promise<DiskState>;describe():Promise<DiskState>;prepareState(input:{publication:true}):Promise<PreparedState>;stateDisk():unknown;commitState():Promise<DiskState>;discardState():Promise<void>;setLoadPrefetch(options:LoadPrefetchOptions):Promise<void>;cancel():void};
 describe():Promise<DiskState>;
 read(offset:number,length:number):Promise<Uint8Array>;
 write(offset:number,bytes:Uint8Array):Promise<DiskState>;
 /** Caller stops and drains its VM first. Preparation preserves the opened disk and writes. */
 publishDisk(options:PublishDiskOptions):Promise<PublishingStatus>;
 publicationDetails(options:{sources:TorrentSources;requireBase?:boolean}):Promise<{hasState:boolean;hasProfiles:boolean;profiles:LoadRangeProfile[];diskInfoHash?:string;publicationInfoHash?:string}>;
 publishUpdate(options:{action:"state"|"remove-state"|"profiles";file?:Blob;profiles?:LoadRangeProfile[];remove?:("boot"|"state")[];compatibility:string;sources:TorrentSources}):Promise<PublishingStatus>;
 publicationStatus():Promise<PublishingStatus>;
 retryPublication():Promise<PublishingStatus>;
 stopSeeding():Promise<void>;
 exportDisk(format?:"encrypted"|"raw"):Promise<{blob:Blob;format:"encrypted"|"raw"}>;
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
