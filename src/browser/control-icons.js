import { icons } from "../../vendor/lucide-1.17.0/icons.js";

function icon(name, className = "")
{
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for(const [key, value] of Object.entries({viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: className}))
        svg.setAttribute(key, value);
    for(const [tag, attributes] of icons[name])
    {
        const node = document.createElementNS(svg.namespaceURI, tag);
        for(const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        svg.append(node);
    }
    return svg;
}

export function setControlIcon(button, name, label, help = label)
{
    button.classList.add("icon-button");
    button.setAttribute("aria-label", label);
    button.title = help;
    if(button.dataset.icon === name) return;
    button.dataset.icon = name;
    const parts = name === "direct" ? [["tablet", "tablet-body"], ["pen", "stylus"]] :
        name === "download-floppy" ? [["save", ""], ["arrow-down", "download-arrow"]] :
        name === "eject" ? [["triangle", "eject-triangle"], ["minus", "eject-bar"]] : [[name, ""]];
    const mark = document.createElement("span");
    mark.className = "icon-mark";
    mark.setAttribute("aria-hidden", "true");
    for(const [symbol, className] of parts) mark.append(icon(symbol, className));
    button.replaceChildren(mark);
}

export function setupControlIcons()
{
    const controls = {
        pause: ["pause", "Pause"], reset: ["rotate-cw", "Reset"],
        "save-state": ["file-down", "Save state"], "load-state": ["folder-open", "Load state"],
        "cancel-state": ["x", "Cancel operation"], ctrlaltdel: ["keyboard", "Ctrl+Alt+Del"],
        mute: ["volume-x", "Mute"], "direct-pointer": ["direct", "Direct pointer"],
        screenshot: ["camera", "Take screenshot"], fullscreen: ["monitor", "Fullscreen"],
        "touch-drag": ["hand", "Drag", "Hold the left mouse button during the next swipe"],
        "touch-right": ["mouse-right", "Right click"],
    };
    for(const drive of ["cdrom", "fda", "fdb"])
    {
        const label = drive === "cdrom" ? "CD" : "floppy " + (drive === "fda" ? "A" : "B");
        controls["insert-" + drive] = [drive === "cdrom" ? "disc" : "save", "Insert " + label];
        if(drive !== "cdrom") controls["download-" + drive] = ["download-floppy", "Download " + label];
    }
    for(const [id, args] of Object.entries(controls)) setControlIcon(document.getElementById(id), ...args);
}
