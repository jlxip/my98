import {bdecode,hex,unhex,infoHash} from './torrent-protocol.js';

/** Receiver observations for one immutable publication, never upload estimates. */
export class PublicationReplicas {
    constructor(root,onChange=()=>{},kinds=['disk','catalog']) {
        this.root=infoHash(root);this.onChange=onChange;this.kinds=new Set(kinds);
        this.components=new Map();this.nodes=new Map();this.wires=new Map();this.serial=0;
        this.closed=false;this.overflow=false;
    }
    expect(kind,part) {
        if(!this.kinds.has(kind)||this.components.has(kind))throw Error('Unexpected publication component');
        this.components.set(kind,{...part,hash:infoHash(part.hash)});this.changed();
    }
    add(kind,torrent) {
        this.expect(kind,{hash:torrent.infoHash,length:torrent.length,pieceLength:torrent.pieceLength,count:torrent.pieces.length});
        const attach=wire=>this.attach(kind,wire);
        torrent.on('wire',attach);
        (this.cleanups||=[]).push(()=>torrent.off('wire',attach));
        for(const wire of torrent.wires||[])attach(wire);
        this.changed();
    }
    attach(kind,wire) {
        if(this.closed||this.wires.has(wire))return;
        const record={kind,wire,node:null,bytes:null,feedtorrent:false,live:true,serial:0};
        this.wires.set(wire,record);
        const progress=()=>{
            if(!record.live)return;
            const part=this.components.get(kind);let bytes=0;
            for(let i=0;i<part.count;i++)if(wire.peerPieces.get(i))bytes+=Math.min(part.pieceLength,part.length-i*part.pieceLength);
            record.bytes=bytes;record.serial=++this.serial;this.observe(record);this.changed();
        };
        const identify=handshake=>{
            let name='';try{name=typeof handshake.v==='string'?handshake.v:new TextDecoder().decode(handshake.v);}catch{}
            record.feedtorrent=name.startsWith('FeedTorrent/');this.changed();
        };
        const tracker=this;
        class ReplicaExtension {
            constructor() {
                wire.extendedHandshake||={};
                wire.extendedHandshake.ft_replica={v:1,root:unhex(tracker.root,20),watch:1};
            }
            onExtendedHandshake(handshake) {
                identify(handshake);
                if(!record.feedtorrent||record.requested)return;
                const extension=handshake.m?.ft_replica;
                if(!Number.isInteger(extension)||extension<1||extension>255)return;
                record.requested=true;
                wire.extended('ft_replica',{v:1,root:unhex(tracker.root,20),watch:1});
            }
            onMessage(bytes) {
                if(!record.live||!record.feedtorrent||!record.requested||bytes.length>2048)return;
                try {
                    const value=bdecode(bytes).value;
                    if(![3,4].includes(Object.keys(value).length)||value.v?.value!==1||!(value.root?.value instanceof Uint8Array)
                        ||hex(value.root.value)!==tracker.root||!(value.node?.value instanceof Uint8Array)||value.node.value.length!==32)return;
                    const id=hex(value.node.value);
                    if(record.node&&record.node!==id)return;
                    if(!tracker.nodes.has(id)) {
                        if(tracker.nodes.size>=256){tracker.overflow=true;tracker.changed();return;}
                        tracker.nodes.set(id,{parts:new Map()});
                    }
                    record.node=id;tracker.observe(record);
                    if(value.parts)record.receipt=tracker.report(record,value.parts.value)===true;
                    tracker.changed();
                }catch{/* Unsupported/malformed observations do not affect transfer. */}
            }
        }
        ReplicaExtension.prototype.name='ft_replica';
        wire.use(ReplicaExtension);
        const extended=(name,handshake)=>{if(name==='handshake')identify(handshake);};
        const close=()=>{
            record.live=false;
            for(const event of ['bitfield','have','have-all','have-none'])wire.off(event,progress);
            wire.lt_donthave?.off('donthave',progress);
            wire.off('extended',extended);wire.off('close',close);
            this.wires.delete(wire);this.changed();
        };
        record.close=close;
        for(const event of ['bitfield','have','have-all','have-none'])wire.on(event,progress);
        wire.lt_donthave?.on('donthave',progress);
        wire.on('extended',extended);wire.once('close',close);
        if(wire.peerPieces?.buffer?.length)progress();
        if(wire.peerExtendedHandshake?.v){identify(wire.peerExtendedHandshake);if(wire.peerExtendedMapping?.ft_replica)wire.ft_replica.onExtendedHandshake(wire.peerExtendedHandshake);}
    }
    observe(record) {
        if(!record.node||record.bytes===null)return;
        const parts=this.nodes.get(record.node).parts,previous=parts.get(record.kind);
        if(!previous||previous.serial<record.serial)parts.set(record.kind,{bytes:record.bytes,serial:record.serial});
    }
    report(record,parts) {
        if(!Array.isArray(parts)||parts.length!==this.components.size||this.components.size!==this.kinds.size)return;
        const observations=new Map();
        for(const part of parts) {
            const value=part.value;
            if(Object.keys(value).length!==3||!(value.id?.value instanceof Uint8Array))return;
            const hash=hex(value.id.value),entry=[...this.components].find(([,part])=>part.hash===hash);
            if(!entry||observations.has(entry[0]))return;
            const [kind,component]=entry,size=value.size?.value,have=value.have?.value;
            if(!Number.isSafeInteger(size)||!Number.isSafeInteger(have)||have<0||have>size
                ||(size!==component.length&&!(size===0&&have===0)))return;
            observations.set(kind,have);
        }
        const node=this.nodes.get(record.node);
        for(const [kind,bytes] of observations) {
            // Standard piece messages on a live component wire are newer than
            // a periodic application snapshot and take precedence on that wire.
            const direct=[...this.wires.values()].some(w=>w.live&&w.node===record.node&&w.kind===kind&&w.bytes!==null);
            if(!direct)node.parts.set(kind,{bytes,serial:++this.serial,reported:true});
        }
        return [...this.components].every(([kind,part])=>observations.get(kind)===part.length);
    }
    snapshot() {
        let complete=0,fraction=0,connected=0;
        const total=[...this.components.values()].reduce((n,p)=>n+p.length,0),ready=this.components.size===this.kinds.size&&total>0;
        for(const [id,node] of this.nodes) {
            const live=[...this.wires.values()].filter(w=>w.node===id&&w.live);
            if(live.length)connected++;
            let full=ready,bytes=0;
            for(const [kind,part] of this.components) {
                const observed=node.parts.get(kind)?.bytes??0;
                if(observed===part.length)bytes+=observed;
                else {
                    full=false;
                    const current=live.filter(w=>w.kind===kind&&w.bytes!==null).sort((a,b)=>b.serial-a.serial)[0];
                    bytes+=current?.bytes??(node.parts.get(kind)?.reported&&live.length?observed:0);
                }
            }
            if(full)complete++;
            else if(ready&&live.length)fraction=Math.max(fraction,Math.min(bytes/total,0.999999999999));
        }
        const unavailable=new Set([...this.wires.values()].filter(w=>w.feedtorrent&&!w.node).map(w=>w.wire.peerId||w.wire));
        const partial=Math.min(99,Math.floor(fraction*100));
        const label=!this.nodes.size&&(unavailable.size||this.overflow)?'—':partial?`${complete}.${String(partial).padStart(2,'0')}`:String(complete);
        return {complete,fraction,connected,unavailable:unavailable.size+(this.overflow?1:0),label};
    }
    changed() {
        if(this.closed)return;
        const value=this.snapshot();
        // Keep the confirmation, but release redundant control wires so a
        // completed cohort cannot occupy all of WebTorrent's connection slots.
        if(this.components.size===this.kinds.size)for(const record of this.wires.values()) {
            const node=this.nodes.get(record.node);
            if(!record.released&&record.receipt&&node&&[...this.components].every(([kind,p])=>node.parts.get(kind)?.bytes===p.length)) {
                record.released=true;
                try {record.wire.extended('ft_replica',{v:1,root:unhex(this.root,20)});}
                catch {/* A departing/disabled peer cannot invalidate its receipt or abort payload transfer. */}
            }
        }
        if(value.complete!==this.lastComplete){clearTimeout(this.timer);this.timer=undefined;this.lastComplete=value.complete;this.onChange(value);}
        else if(!this.timer)this.timer=setTimeout(()=>{this.timer=undefined;if(!this.closed)this.onChange(this.snapshot());},250);
    }
    close() {
        this.closed=true;clearTimeout(this.timer);
        for(const wire of [...this.wires.values()])wire.close();
        for(const cleanup of this.cleanups||[])cleanup();
        this.nodes.clear();this.components.clear();
    }
}
