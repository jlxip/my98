const helpers = new Set();

/** Basecoat owns the click toggle and mutual exclusion; transient help dismisses without moving focus. */
export function addHelp(label, {id, text, button, content}) {
    const wrapper = button?.parentElement || document.createElement('span');
    wrapper.classList.add('popover', 'ui-help');
    if(!button) {
        button = document.createElement('button');
        button.type = 'button';button.className = 'btn ui-info';button.dataset.variant = 'ghost';button.textContent = 'i';
        content = document.createElement('span');
        wrapper.append(button, content);label.after(wrapper);
    }
    button.id ||= id+'-info';content.id ||= id+'-help';
    button.classList.add('ui-info');button.disabled=false;button.setAttribute('aria-label', 'About '+id.replaceAll('-', ' '));
    button.setAttribute('aria-controls', content.id);button.setAttribute('aria-describedby', content.id);button.setAttribute('aria-expanded', 'false');
    content.classList.add('ui-help-content');content.dataset.popover = '';content.hidden = false;
    content.setAttribute('role','tooltip');content.setAttribute('aria-hidden','true');
    let automatic = false, pinned = false, hovering = false, suppressed = false;
    const opened = () => button.getAttribute('aria-expanded') === 'true';
    const refresh = () => {content.textContent = typeof text === 'function' ? text() : text;};
    function position() {
        if(!opened()) return;
        const rect = button.getBoundingClientRect(), box = {width:content.offsetWidth,height:content.offsetHeight};
        const left = Math.max(8, Math.min(rect.left, innerWidth-box.width-8));
        const top = rect.bottom+8+box.height <= innerHeight-8 ? rect.bottom+8 : Math.max(8, rect.top-box.height-8);
        content.style.left = left+'px';content.style.top = top+'px';
    }
    function setOpen(value) {
        if(value === opened() || value && suppressed) return;
        if(!value) {
            button.setAttribute('aria-expanded','false');content.setAttribute('aria-hidden','true');
            return;
        }
        refresh();automatic = true;
        try {button.click();} finally {automatic = false;}
        position();
    }
    button.addEventListener('click', event => {
        if(automatic) return;
        suppressed = false;refresh();
        if(opened()) {
            if(!pinned) pinned = true;
            else {pinned = false;suppressed = true;setOpen(false);}
            event.stopImmediatePropagation();return;
        }
        pinned = true;
    }, true);
    wrapper.addEventListener('mouseenter', () => {hovering = true;suppressed = false;setOpen(true);});
    wrapper.addEventListener('mouseleave', () => {hovering = false;if(!pinned && !wrapper.contains(document.activeElement)) setOpen(false);});
    wrapper.addEventListener('focusin', () => {suppressed = false;refresh();setOpen(true);});
    wrapper.addEventListener('focusout', () => queueMicrotask(() => {
        if(!wrapper.contains(document.activeElement)) {suppressed = false;if(!hovering && !pinned)setOpen(false);}
    }));
    new MutationObserver(() => {if(opened()){refresh();position();}else pinned = false;})
        .observe(button,{attributes:true,attributeFilter:['aria-expanded']});
    const helper = {opened, contains:target=>wrapper.contains(target), update(){refresh();position();}, close(){pinned = false;setOpen(false);}, escape(){pinned=false;suppressed=true;setOpen(false);}};
    helpers.add(helper);refresh();window.basecoat.init('popover');
    return helper;
}

document.addEventListener('keydown',event=>{if(event.key==='Escape'){const current=[...helpers].find(helper=>helper.opened());if(current){event.preventDefault();event.stopImmediatePropagation();current.escape();}}},true);
document.addEventListener('click',event=>{for(const helper of helpers)if(helper.opened()&&!helper.contains(event.target))helper.close();},true);
document.addEventListener('my98:controlchange', () => helpers.forEach(helper => helper.update()));
document.addEventListener('my98:modalchange', () => helpers.forEach(helper => helper.close()));
window.addEventListener('resize', () => helpers.forEach(helper => helper.update()));
document.addEventListener('scroll', () => helpers.forEach(helper => helper.update()), true);

export function setupControlHelp() {
    for(const fieldset of document.querySelectorAll('#controls fieldset')) {
        const legend = fieldset.querySelector('legend');
        const name = legend.textContent.trim();
        // Keep the i next to the group's label, not next to each control.
        const label = document.createElement('span');label.textContent = name;legend.replaceChildren(label);
        addHelp(label, {id:name.toLowerCase().replaceAll(' ', '-'),text:() => [
            fieldset.querySelector('.media > span')?.textContent,
            ...[...fieldset.querySelectorAll('button[data-help]')].map(button => button.dataset.help),
        ].filter(Boolean).join('\n')});
    }
    addHelp(document.getElementById('disk-name'), {id:'disk-name',text:() => document.getElementById('disk-name').textContent+'\n'+document.getElementById('fullscreen').dataset.help});
    const progress = document.getElementById('disk-progress');
    addHelp(progress,{id:'disk-coverage',text:'Disk bytes available in this browser session. This measures coverage, not a permanent backup.'});
    const coverage = progress.nextElementSibling;
    const sync = () => {coverage.hidden = progress.hidden;};sync();
    new MutationObserver(sync).observe(progress,{attributes:true,attributeFilter:['hidden']});
    addHelp(document.getElementById('touch-hint'),{id:'touch-controls',text:() => ['Slide to move. Tap to click.',document.getElementById('touch-drag').dataset.help,document.getElementById('touch-right').dataset.help,document.getElementById('fullscreen').dataset.help].join('\n')});
}
