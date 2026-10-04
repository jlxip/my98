const letters={a:0x1e,b:0x30,c:0x2e,d:0x20,e:0x12,f:0x21,g:0x22,h:0x23,i:0x17,j:0x24,k:0x25,l:0x26,m:0x32,n:0x31,o:0x18,p:0x19,q:0x10,r:0x13,s:0x1f,t:0x14,u:0x16,v:0x2f,w:0x11,x:0x2d,y:0x15,z:0x2c};
const digits=[0x0b,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a];
const keypad=[0x52,0x4f,0x50,0x51,0x4b,0x4c,0x4d,0x47,0x48,0x49];
const special={enter:[0x1c],tab:[0x0f],escape:[0x01],esc:[0x01],space:[0x39],backspace:[0x0e],delete:[0xe0,0x53],insert:[0xe0,0x52],home:[0xe0,0x47],end:[0xe0,0x4f],up:[0xe0,0x48],down:[0xe0,0x50],left:[0xe0,0x4b],right:[0xe0,0x4d],pageup:[0xe0,0x49],pagedown:[0xe0,0x51],ctrl:[0x1d],control:[0x1d],alt:[0x38],shift:[0x2a],win:[0xe0,0x5b],meta:[0xe0,0x5b]};
const extras='€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export function release(code){return [...code.slice(0,-1),code.at(-1)|0x80];}
export function keyCodes(name){
    const n=String(name).toLowerCase();
    if(special[n])return special[n];
    if(n==='numlock')return [0x45];
    if(n==='capslock')return [0x3a];
    if(letters[n])return [letters[n]];
    if(/^\d$/.test(n))return [digits[Number(n)]];
    if(/^f([1-9]|1[0-2])$/.test(n)){const f=Number(n.slice(1));return [f<=10?0x3a+f:f===11?0x57:0x58];}
    if(/^num[0-9]$/.test(n))return [keypad[Number(n.at(-1))]];
    throw new Error('Unsupported key: '+name);
}
export function chordCodes(chord){
    if(typeof chord!=='string'||chord.length>80)throw new Error('Invalid key combination');
    const names=chord.split('+');
    if(!names.length||names.length>5||names.slice(0,-1).some(n=>!['ctrl','control','alt','shift','win','meta'].includes(n.toLowerCase())))throw new Error('Use modifiers followed by one key');
    const keys=names.map(keyCodes);
    return [...keys.flat(),...keys.toReversed().flatMap(release)];
}
export function textCodes(text){
    if(typeof text!=='string'||text.length>16384)throw new Error('Text must contain at most 16384 characters');
    const result=[];
    for(const char of text.replaceAll('\r\n','\n')){
        let code;
        if(char==='\n'||char==='\r')code=special.enter;
        else if(char==='\t')code=special.tab;
        // Windows Alt+0ddd uses CP1252, independent of keyboard layout/Caps Lock.
        if(code){result.push(...code,...release(code));continue;}
        const point=char.codePointAt(0),extra=extras.indexOf(char);
        const value=point>=32&&point<=126||point>=160&&point<=255?point:extra>=0&&![129,141,143,144,157].includes(extra+128)?extra+128:null;
        if(value===null)throw new Error('Character is not representable in Windows-1252: '+char);
        result.push(0x38);
        for(const digit of ('0'+String(value).padStart(3,'0'))){const k=[keypad[Number(digit)]];result.push(...k,...release(k));}
        result.push(0xb8);
    }
    return result;
}
