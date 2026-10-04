const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const unhex = text => {
    if(typeof text !== 'string' || !/^[0-9a-f]{64}$/.test(text)) throw new Error('Invalid relay nonce');
    return Uint8Array.from(text.match(/../g),v=>parseInt(v,16));
};
export const RELAY_PROTOCOL='my98-relay.v1';
/** Ethernet bridge. The signer owns secrets in a Worker; the adapter owns no VM state. */
export class RelayNetworkAdapter {
    constructor(bus, {url, resolveURL, signer, onState=()=>{}, WebSocketClass=globalThis.WebSocket, origin=globalThis.location?.origin} = {}) {
        this.bus=bus;this.url=url;this.signer=signer;this.onState=onState;
        this.WebSocketClass=WebSocketClass;this.origin=origin;this.delay=1000;
        this.fixedURL=url;this.resolveURL=resolveURL;
        this.ready=false;this.closed=false;this.generation=0;
        this.send = frame => {
            if(!this.ready || !this.socket || this.socket.readyState!==1) return;
            if(frame.byteLength>1514 || this.socket.bufferedAmount>65536) return;
            this.socket.send(frame);
        };
        bus.register('net0-send',this.send,this);
        this.stopWatching=signer.onClosed?.(()=>{this.state('identity-closed');this.destroy(false);});
        this.connect();
    }
    state(status) {this.status=status;this.onState(status,this);}
    async connect() {
        clearTimeout(this.retryTimer);
        clearTimeout(this.authTimer);
        const generation=++this.generation;
        this.ready=false;this.socket?.close();
        this.discoveryController?.abort();
        if(this.closed) return;
        this.state('connecting');
        let publicKey;
        try {publicKey=hex(await this.signer.relayPublicKey());}
        catch { if(generation===this.generation){this.state('identity-closed');this.destroy(false);}return; }
        if(generation!==this.generation || this.closed) return;
        const controller=new AbortController();this.discoveryController=controller;
        let url;
        try {url=this.fixedURL || await this.resolveURL(controller.signal);}
        catch {this.reconnect(generation);return;}
        if(generation!==this.generation || this.closed)return;
        this.url=url;
        let socket;
        try {socket=new this.WebSocketClass(this.url,RELAY_PROTOCOL);}
        catch {this.reconnect(generation);return;}
        this.socket=socket;socket.binaryType='arraybuffer';let phase='hello';
        const current=()=>generation===this.generation&&!this.closed;
        this.authTimer=setTimeout(()=>{if(current()&&!this.ready)socket.close();},15000);
        socket.onopen=()=>{
            if(!current())return;
            if(socket.protocol!==RELAY_PROTOCOL){phase='rejected';this.state('rejected');socket.close();return;}
            socket.send(JSON.stringify({type:'hello',publicKey}));
        };
        socket.onmessage=async event=>{
            if(!current())return;
            try {
                if(event.data instanceof ArrayBuffer) {
                    if(!this.ready || event.data.byteLength<14 || event.data.byteLength>1514)throw Error();
                    this.bus.send('net0-receive',new Uint8Array(event.data));return;
                }
                const message=JSON.parse(event.data);
                if(message.type==='challenge' && phase==='hello' && message.url===this.url && message.origin===this.origin &&
                   Number.isSafeInteger(message.expires) && message.expires*1000>=Date.now()-1000 && message.expires*1000<=Date.now()+11000) {
                    phase='signing';
                    const signature=await this.signer.signRelayChallenge({url:this.url,origin:this.origin,nonce:unhex(message.nonce),expires:message.expires});
                    if(!current() || socket.readyState!==1)return;
                    phase='authenticated';socket.send(JSON.stringify({type:'authenticate',signature:hex(signature)}));
                } else if(message.type==='ready' && phase==='authenticated') {
                    phase='ready';this.ready=true;this.delay=1000;clearTimeout(this.authTimer);this.state('online');
                } else throw Error();
            } catch {
                if(current()){phase='rejected';this.state('rejected');socket.close();}
            }
        };
        socket.onerror=()=>{}; // browsers expose no reliable HTTP status here
        socket.onclose=event=>{
            if(!current())return;
            clearTimeout(this.authTimer);this.ready=false;
            if(event.code===1008 || phase==='rejected'){this.state('rejected');return;}
            this.reconnect(generation);
        };
    }
    reconnect(generation) {
        if(this.closed || generation!==this.generation)return;
        this.ready=false;this.state('offline');
        const delay=this.delay;this.delay=Math.min(30000,this.delay*2);
        this.retryTimer=setTimeout(()=>this.connect(),delay);
    }
    retry() {if(!this.closed){this.delay=1000;return this.connect();}}
    destroy(update=true) {
        if(this.closed)return;
        this.closed=true;this.ready=false;++this.generation;
        clearTimeout(this.retryTimer);clearTimeout(this.authTimer);
        this.socket?.close();this.bus.unregister('net0-send',this.send);
        this.discoveryController?.abort();
        this.stopWatching?.();this.stopWatching=undefined;
        this.signer=undefined;
        if(update)this.state('closed');
    }
}
