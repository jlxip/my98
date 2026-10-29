import test from "node:test";
import assert from "node:assert/strict";
import {createHash,createPublicKey,verify} from "node:crypto";
import {verifyRecord,parseRecord,verifyLocations,parseLocations,compareRecords,parseDescriptor,verifyMetadata} from "../src/disk/web/torrent-protocol.js";
import {Slop86Disk} from '../src/disk/web/client.js';

test('native Worker errors retain Safari message, location and cause',async()=>{
    const original=globalThis.Worker;let worker,prevented=false;
    class Worker {
        constructor(){worker=this;}
        postMessage(message){message.port?.close();}
        terminate(){this.terminated=true;}
    }
    globalThis.Worker=Worker;
    try {
        const opening=Slop86Disk.create(),cause=new TypeError('Uint8Array operation is unavailable');
        worker.onerror({preventDefault(){prevented=true;},message:cause.message,error:cause,filename:'worker.js',lineno:42,colno:7});
        await assert.rejects(opening,error=>{
            assert.equal(error.message,cause.message);assert.equal(error.code,'DISK_WORKER_ERROR');
            assert.equal(error.cause,cause);assert.equal(error.resource,'worker.js:42:7');return true;
        });
        assert(prevented&&worker.terminated);
    }finally{globalThis.Worker=original;}
});

const publicKey="07d2860c1066244fa0d7973545b4dd822466d8b2c9fd83fb84331716949b3a54";
const record={publicKey,sequence:123,infoHash:"12".repeat(20),salt:Buffer.from("my98/publication/v1").toString("hex"),
    signature:"512b1784e462afb245621af1ea416b1bbf35556f15d1f31372fa6a23c787f489b980fbb56f60dc0ca133904e41bac76796ee3a9c698ef09e251f2c8e6076f50b"};
const verifier=(pk,message,sig)=>verify(null,message,createPublicKey({key:Buffer.concat([
    Buffer.from("302a300506032b6570032100","hex"),pk]),format:"der",type:"spki"}),sig);
function encode(value) {
    if(Number.isInteger(value))return Buffer.from("i"+value+"e");
    if(typeof value==="string")value=Buffer.from(value);
    if(value instanceof Uint8Array)return Buffer.concat([Buffer.from(value.length+":"),value]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from("l"),...value.map(encode),Buffer.from("e")]);
    return Buffer.concat([Buffer.from("d"),...Object.keys(value).sort().flatMap(key=>[encode(key),encode(value[key])]),Buffer.from("e")]);
}

test("Python/Rust BEP44 vectors verify with exact target and safe sequence",()=>{
    assert.equal(verifyRecord(record,publicKey,verifier).sequence,123);
    const maximum={...record,sequence:Number.MAX_SAFE_INTEGER,infoHash:"34".repeat(20),
        signature:"d69cbee3bba77d17a2023e2ad59a2cffd313df77e4273f22bc17d713970e726a05f8067004df1ca1b8172c143849d4456a77e0cc82c86192c914d00d0d808504"};
    verifyRecord(maximum,publicKey,verifier);
    parseRecord(JSON.stringify(maximum),publicKey,verifier);
    assert.throws(()=>parseRecord(JSON.stringify(maximum).replace("9007199254740991","9007199254740990.9"),publicKey,verifier),/exact JSON integer/);
    for(const invalid of [{...record,sequence:2**53},{...record,sequence:123.5},{...record,salt:"00"},
        {...record,signature:"00".repeat(64)},{...record,publicKey:"ab".repeat(32)}])
        assert.throws(()=>verifyRecord(invalid,publicKey,verifier));
    assert.equal(compareRecords(record,record),false);
    assert.throws(()=>compareRecords(maximum,record),/older/);
    assert.throws(()=>compareRecords(record,{...record,infoHash:"56".repeat(20)}),/same sequence/);
});

test("descriptor duplicate escaped keys and unexpected fields are rejected",()=>{
    const valid={version:1,disk:record.infoHash,state:null,profile:null};
    assert.deepEqual(parseDescriptor(JSON.stringify(valid)),valid);
    assert.throws(()=>parseDescriptor('{"version":1,"disk":"'+record.infoHash+'","\\u0064isk":"'+record.infoHash+'","state":null,"profile":null}'),/Duplicate/);
    assert.throws(()=>parseDescriptor(JSON.stringify({...valid,profile:"https://arbitrary.invalid"})));
    assert.throws(()=>parseDescriptor(JSON.stringify({...valid,version:true})));
    assert.throws(()=>parseDescriptor(JSON.stringify(valid).replace('"version":1','"version":1.0')),/exact JSON integer/);
});

test("v1 metadata validates exact hash/shape and removes unsigned network hints",async()=>{
    const info={name:"disk.my98",length:600000,"piece length":256*1024,pieces:Buffer.alloc(60,12)};
    const ih=createHash("sha1").update(encode(info)).digest("hex");
    const metadata=encode({info,announce:"wss://arbitrary.invalid","url-list":["https://arbitrary.invalid/disk"]});
    const parsed=await verifyMetadata(metadata,ih,"disk");
    assert.equal(parsed.size,600000);
    assert.deepEqual(parsed.metadata,new Uint8Array(encode({info})));
    await assert.rejects(verifyMetadata(metadata,"00".repeat(20),"disk"),/infohash/);
    await assert.rejects(verifyMetadata(metadata,ih,"state"),/filename/);
    for(const change of [{"piece length":16384},{files:[]},{pieces:Buffer.alloc(40)},{length:2**53}]) {
        const changed={...info,...change},bytes=encode({info:changed});
        const changedHash=createHash("sha1").update(encode(changed)).digest("hex");
        await assert.rejects(verifyMetadata(bytes,changedHash,"disk"));
    }
});


test("signed locations agree with Python and cannot change identity or destinations",()=>{
    const locations={publicKey:"03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",sequence:123,
        origins:["https://other.example:8445","https://seedbox.example:8445"],salt:Buffer.from("my98/locations/v1").toString("hex"),
        signature:"6cdab6e2d9484ec4a1b67302315b06f46d00cd0c5005e6fd904a41ec544c694c3bc9d92a308ac0dab750d25108f7204e7dce45ad1f67ed4f881f89eca80f9e08"};
    assert.deepEqual(verifyLocations(locations,locations.publicKey,verifier).origins,locations.origins);
    parseLocations(JSON.stringify(locations),locations.publicKey,verifier);
    for(const change of [{origins:["https://attacker.example"]},{sequence:124},{origins:[...locations.origins].reverse()},
        {salt:record.salt},{signature:"00".repeat(64)},{origins:["http://example.com"]}])
        assert.throws(()=>verifyLocations({...locations,...change},locations.publicKey,verifier));
    assert.throws(()=>verifyLocations(locations,publicKey,verifier));
    assert.throws(()=>parseLocations(JSON.stringify(locations).replace('"sequence":123','"sequence":123.0'),locations.publicKey,verifier));
});
