export interface DiskState {readOnly:boolean;size:number;disk_id:number[];dirty_bytes:number;dirty_sectors:number;cache_bytes:number;revision:number;remote?:{ipnsName?:string;path:string;cid:string;sequence?:string;gateway:string;rootCid?:string;resolutionServer?:string};}
export interface PreparedDownload {id:number;blob:Blob;size:number;}
export interface SavedDisk extends DiskState {outcome:"created"|"unchanged";download?:PreparedDownload;}
export interface BootRangeProfile {version:1;cid:string;unitBytes:65536;ranges:([number,number]|null)[];}
export interface GeneratedBootRangeProfile extends BootRangeProfile {minUtilization:number;observedUnits:number;coveredUnits:number;downloadUnits:number;}
export interface PrefetchOptions {enabled?:boolean;policy?:'auto'|'sequential'|'demand'|'head-demand'|'fresh-demand'|'nearby'|'streams'|'ranges';bootProfile?:BootRangeProfile;concurrency?:1|2|3|4|5|6|7|8;trace?:boolean;}
export interface DiscoveryStats {state:'idle'|'skipped'|'running'|'complete'|'limited'|'failed'|'cancelled';providers:number;verifiedProviders:number;verifiedEndpoints:number;endpointsTested?:number;receivedBytes?:number;limits?:string[];failures?:{stage:string;target:string;code:string;message:string}[];error?:{code:string;message:string};}
export interface EndpointStats {url:string;active:number;validBytes:number;failures:number;bytesPerMs:number;cooldownUntil:number;excluded:boolean;}
export interface RemoteStats {endpoints:EndpointStats[];discovery:DiscoveryStats;rangeProfile?:{ranges:number;units:number;completedUnits:number};retainedBytes:number;coveredBytes:number;totalBytes:number;completedUnits:number;totalUnits:number;inFlight:number;queued:number;prefetchState:'idle'|'running'|'paused'|'stopped'|'complete'|'closed';prefetchError?:{code:string;message:string};policy:string;concurrency:number;traceDropped:number;}
export interface DiskTraceEvent {type:string;unit?:number;policy?:string;time:number;offset?:number;length?:number;ms?:number;cid?:string;gateway?:string;priority?:string;hit?:boolean;bytes?:number;code?:string;}
export interface QueryServer {url:string;resolution:'gateway'|'routing'|false;discovery:boolean;}
export class Slop86Disk {
 static create(options?:{workerUrl?:URL|string;onProgress?:(progress:{phase:string;completed:number;total:number;readBytes:number;readCalls:number})=>void;onAnalysis?:(event:{type:'analysis';error:string})=>void}):Promise<Slop86Disk>;
 unlock(username:string,password:string,machine:string):Promise<{ipnsName:string;publicKey:number[]}>;
 createFromImage(file:File|Blob):Promise<SavedDisk>;
 createEmpty(sizeBytes:number):Promise<SavedDisk>;
 open(file:File|Blob):Promise<DiskState>;
 openRemote(options?:{gateway?:string;servers?:QueryServer[];onlyLocalhost?:boolean;prefetch?:PrefetchOptions}):Promise<DiskState>;
 /** Export a capability for the current clean disk version. Treat the returned string as a secret. */
 exportReadOnlyKey():Promise<string>;
 /** Open a CID using a my98-ro-v1 capability, without unlocking an identity. Writes live only in RAM. */
 openReadOnly(options:{cid:string;readKey:string;gateway?:string;servers?:QueryServer[];onlyLocalhost?:boolean;prefetch?:PrefetchOptions}):Promise<DiskState>;
 describe():Promise<DiskState>;
 read(offset:number,length:number):Promise<Uint8Array>;
 write(offset:number,bytes:Uint8Array):Promise<DiskState>;
 save():Promise<SavedDisk>;
 downloadCurrent():Promise<PreparedDownload>;
 retryDownload():Promise<PreparedDownload>;
 verifyImage():Promise<Uint8Array>;
 discardWrites():Promise<DiskState>;
 readStats():Promise<{readBytes:number;readCalls:number;networkBytes:number;networkRequests:number;blockCacheBytes:number;remote?:RemoteStats}>;
 readTrace():Promise<DiskTraceEvent[]>;
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
