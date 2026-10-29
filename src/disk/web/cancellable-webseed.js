import WebConn from 'webtorrent/lib/webconn.js';

// Use WebTorrent's connection extension point, keeping its wire protocol and
// piece verification. Closing a source must also release browser HTTP slots.
class CancellableWebSeed extends WebConn {
    constructor(url,torrent) {
        super(url,torrent);this.requests=new Set();
    }
    async httpRequest(pieceIndex,offset,length,callback) {
        const controller=new AbortController(),torrent=this._torrent;
        if(this.destroyed || !torrent){callback(new Error('Webseed closed'));return;}
        const start=pieceIndex*torrent.pieceLength+offset,end=start+length-1;
        const timer=setTimeout(()=>controller.abort(new Error('Webseed request timed out')),60000);
        this.requests.add(controller);let bytes,error;
        try {
            const response=await fetch(this.url,{method:'GET',cache:'no-store',credentials:'omit',redirect:'error',
                headers:{Range:`bytes=${start}-${end}`},signal:controller.signal});
            if(response.status!==206 || response.headers.get('Content-Range')!==`bytes ${start}-${end}/${torrent.length}`)
                throw new Error('Invalid webseed range response');
            const reader=response.body.getReader();bytes=new Uint8Array(length);let copied=0;
            try {
                for(;;) {
                    const {done,value}=await reader.read();if(done)break;
                    if(copied+value.length>length)throw new Error('Oversized webseed range');
                    bytes.set(value,copied);copied+=value.length;
                }
                if(copied!==length)throw new Error('Short webseed range');
            }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
            if(controller.signal.aborted)throw controller.signal.reason;
        }catch(cause){error=cause;controller.abort(cause);}
        finally{clearTimeout(timer);this.requests.delete(controller);}
        callback(error,bytes);
    }
    destroy() {
        for(const request of this.requests||[])request.abort(new Error('Webseed closed'));
        super.destroy();
    }
}
export const createWebSeed=(url,torrent)=>new CancellableWebSeed(url,torrent);
