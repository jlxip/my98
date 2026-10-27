"""Exact, verified source adaptation for libtorrent 2.1.2 WebTorrent ICE mux."""
import hashlib
from pathlib import Path

FILES = {'include/libtorrent/settings_pack.hpp': {'before': 'f4907af713a1632cbc4286acac2f15742a8bc842539d759d93ba9cc05b24cd3e', 'after': '62337e41eb67a56c4365352143cc4444a18fd1df7fa16154762c6ac6248bbe01'}, 'src/settings_pack.cpp': {'before': 'ebba4f2fb56101e6ff425350d008bf61b30282a16b614a85ad7adbfc1195f07a', 'after': '4ccb75f1a1923dd1d59cea3610dc5f9f4da9de2be9a5e81b80fcb9cec2a87a0d'}, 'src/rtc_signaling.cpp': {'before': '16058554f3d04a5532275e63c18da610ba22091d038c35145015fb4310b18308', 'after': '7b8ff1263da4ea20f5fd91c3ad17b96218784db9130cef1e3e830c34bb8e6c72'}}

CHANGES = {'include/libtorrent/settings_pack.hpp': ('\t\t\tmax_int_setting_internal', '\t\t\t// Local UDP port shared by WebTorrent ICE connections in this process.\n\t\t\t// Zero preserves the default ephemeral sockets; 1..65535 enables UDP mux.\n\t\t\twebtorrent_ice_udp_port,\n\n\t\t\tmax_int_setting_internal'), 'src/settings_pack.cpp': ('SET(max_webtorrent_offers, 10, nullptr)', 'SET(max_webtorrent_offers, 10, nullptr),\n\t\tSET(webtorrent_ice_udp_port, 0, nullptr)'), 'src/rtc_signaling.cpp': ('\trtc::Configuration config;', '\trtc::Configuration config;\n\tint const ice_udp_port = m_torrent->settings().get_int(settings_pack::webtorrent_ice_udp_port);\n\tif (ice_udp_port > 0 && ice_udp_port <= 65535)\n\t{\n\t\tconfig.enableIceUdpMux = true;\n\t\tconfig.portRangeBegin = static_cast<std::uint16_t>(ice_udp_port);\n\t\tconfig.portRangeEnd = static_cast<std::uint16_t>(ice_udp_port);\n\t}')}


def apply(source):
    source = Path(source)
    originals = {name:(source/name).read_bytes() for name in FILES}
    actual = {name:hashlib.sha256(value).hexdigest() for name,value in originals.items()}
    before = {name:value["before"] for name,value in FILES.items()}
    after = {name:value["after"] for name,value in FILES.items()}
    if actual == after:
        return
    if actual != before:
        raise RuntimeError("Unexpected or partially transformed libtorrent source")
    replacements = {}
    for name,(old,new) in CHANGES.items():
        data = originals[name]
        if data.count(old.encode()) != 1:
            raise RuntimeError("Native adaptation anchor mismatch: "+name)
        data = data.replace(old.encode(),new.encode())
        if hashlib.sha256(data).hexdigest() != after[name]:
            raise RuntimeError("Native adaptation result mismatch: "+name)
        replacements[name] = data
    # Validate all three outputs before writing any source file.
    for name,data in replacements.items():
        (source/name).write_bytes(data)
