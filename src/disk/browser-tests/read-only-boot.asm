; Disposable fixture: exercise BIOS disk writes and reads, then report over COM1.
bits 16
org 0x7c00
cli
xor ax, ax
mov ds, ax
mov es, ax
mov ss, ax
mov sp, 0x7c00
sti
mov [disk], dl
mov word [0x7e00], 0xbeef
mov bx, 0x7e00
mov ax, 0x0301
mov cx, 2
xor dh, dh
int 0x13
jc failure
mov bx, 0x8000
mov ax, 0x0201
mov cx, 2
xor dh, dh
mov dl, [disk]
int 0x13
jc failure
cmp word [0x8000], 0xbeef
jne failure
mov si, success
jmp print
failure:
mov si, error
print:
lodsb
test al, al
jz done
mov dx, 0x3f8
out dx, al
jmp print
done:
cli
hlt
jmp done
disk: db 0
success: db "READ_ONLY_BOOT_OK", 10, 0
error: db "READ_ONLY_BOOT_FAILED", 10, 0
times 510-($-$$) db 0
dw 0xaa55
