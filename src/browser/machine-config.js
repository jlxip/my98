export const DEFAULT_CONFIG=Object.freeze({memory_size:512*1024*1024,vga_memory_size:8*1024*1024,boot_order:0x312,acpi:false,network:"ne2k"});
export function validateConfig(c) {
    if(!c || !Number.isInteger(c.memory_size) || c.memory_size<16*1024*1024 || c.memory_size>512*1024*1024 || c.memory_size%1048576 ||
        !Number.isInteger(c.vga_memory_size) || c.vga_memory_size<1024*1024 || c.vga_memory_size>16*1024*1024 || c.vga_memory_size%1048576 || c.boot_order!==0x312 || c.acpi!==false || c.network!=="ne2k")throw new Error("Unsupported saved machine configuration");
    return {...c};
}
