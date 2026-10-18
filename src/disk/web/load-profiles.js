import {matchingRanges} from './range-prefetch.js';

export const MAX_PROFILE_BYTES = 65536;
const invalid = () => Object.assign(new Error('Invalid load profiles.'), {code:'INVALID_PROFILE'});
export const sameOrigin = (a,b) => a?.kind===b?.kind && (a?.kind==='boot' || a?.sha256===b?.sha256);

// Public hints only. The authenticated disk and state remain the authorities.
export function validateLoadProfiles(value, infoHash, units) {
    if(!Array.isArray(value) || value.length>2) throw invalid();
    const kinds=new Set();
    for(const p of value) {
        if(!p || p.version!==2 || p.infoHash!==infoHash || p.unitBytes!==65536 || !p.origin ||
            !['boot','state'].includes(p.origin.kind) || kinds.has(p.origin.kind)) throw invalid();
        if(!/^[0-9a-f]{40}$/.test(p.infoHash))throw invalid();
        if(p.origin.kind==='state' && !/^[0-9a-f]{64}$/.test(p.origin.sha256))throw invalid();
        if(p.origin.kind==='boot' && p.origin.sha256!==undefined)throw invalid();
        if(!matchingRanges({...p,version:1},infoHash,units))throw invalid();
        if(p.minUtilization!==undefined && (!Number.isFinite(p.minUtilization) || p.minUtilization<=0 || p.minUtilization>1))throw invalid();
        for(const key of ['observedUnits','coveredUnits','downloadUnits']) {
            if(p[key]!==undefined && (!Number.isSafeInteger(p[key]) || p[key]<0 || p[key]>units))throw invalid();
        }
        kinds.add(p.origin.kind);
    }
    return value;
}
