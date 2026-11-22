import {Slop86Disk} from '/build/disk/web/client.js';
import {RelayNetworkAdapter} from '/src/browser/relay-network.js';
import {discoverRelay} from '/src/disk/web/relay-discovery.js';

// A separate Worker owns only the relay identity. It never opens the local disk,
// imports a publication or stores credentials in a checkpoint.
export class AgentNetwork {
    state='identity-closed';
    async login(vm,credentials){
        if(!vm)throw new Error('Use start first');
        for(const key of ['username','password','machine'])if(typeof credentials?.[key]!=='string'||!credentials[key]||new TextEncoder().encode(credentials[key]).length>4096)throw new Error('Expected username, password and machine (1–4096 UTF-8 bytes each)');
        const url=credentials.relayURL;
        if(url!==undefined){
            let parsed;try{parsed=new URL(url);}catch{throw new Error('Invalid relay URL');}
            if(parsed.protocol!=='wss:'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/my98-relay/v1')throw new Error('Expected a WSS relay URL ending in /my98-relay/v1');
        }
        const client=await Slop86Disk.create();
        try{
            await client.unlock(credentials.username,credentials.password,credentials.machine);
            const publicKey=Array.from(await client.relayPublicKey(),b=>b.toString(16).padStart(2,'0')).join('');
            await this.logout();this.client=client;
            vm.network_adapter=new RelayNetworkAdapter(vm.bus,{signer:client,url,
                resolveURL:signal=>discoverRelay({signal}),onState:state=>{this.state=state;}});
            this.adapter=vm.network_adapter;
            return {publicKey,...this.status()};
        }catch(error){await client.close().catch(()=>{});throw error;}
        finally{credentials.password='';}
    }
    status(){return {state:this.state,origin:location.origin};}
    retry(){if(!this.adapter)throw new Error('Use network-login first');this.adapter.retry();return this.status();}
    async logout(){
        this.adapter?.destroy();this.adapter=undefined;
        const client=this.client;this.client=undefined;
        if(client)await client.close();this.state='identity-closed';return this.status();
    }
}
