export interface DiskState {size:number;disk_id:number[];dirty_bytes:number;dirty_sectors:number;cache_bytes:number;revision:number;remote?:{ipnsName:string;path:string;cid:string;sequence:string;gateway:string};}
export interface PreparedDownload {id:number;blob:Blob;size:number;}
export interface SavedDisk extends DiskState {outcome:"created"|"unchanged";download?:PreparedDownload;}
export class Slop86Disk {
 static create(options?:{workerUrl?:URL|string;onProgress?:(progress:{phase:string;completed:number;total:number;readBytes:number;readCalls:number})=>void}):Promise<Slop86Disk>;
 unlock(username:string,password:string,machine:string):Promise<{ipnsName:string;publicKey:number[]}>;
 createFromImage(file:File|Blob):Promise<SavedDisk>;
 open(file:File|Blob):Promise<DiskState>;
 openRemote(options?:{gateway?:string}):Promise<DiskState>;
 describe():Promise<DiskState>;
 read(offset:number,length:number):Promise<Uint8Array>;
 write(offset:number,bytes:Uint8Array):Promise<DiskState>;
 save():Promise<SavedDisk>;
 downloadCurrent():Promise<PreparedDownload>;
 retryDownload():Promise<PreparedDownload>;
 verifyImage():Promise<Uint8Array>;
 discardWrites():Promise<DiskState>;
 readStats():Promise<{readBytes:number;readCalls:number;networkBytes:number;networkRequests:number;blockCacheBytes:number}>;
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
