#!/usr/bin/env python3
"""Install the optional native relay. Installation does not enable a new service."""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parent.parent
CONFIG = Path('/etc/my98-relay/config.json')

def configuration(url, system, old=None, origins=None, host_ips=None):
    parsed = urlsplit(url)
    if parsed.scheme != 'wss' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != '/my98-relay/v1':
        raise ValueError('Use wss://HOST/my98-relay/v1')
    value = dict(old or {})
    if type(value.get('enabled',False)) is not bool: raise ValueError('enabled must be boolean')
    value.update(public_url=url, enabled=value.get('enabled', False),
                 allow_file='/var/lib/my98-relay/allow.json',
                 admin_socket=('/var/run' if system == 'OpenBSD' else '/run')+'/my98-relay/admin.sock')
    value['origins'] = origins or value.get('origins') or ['https://my98.lol', 'http://127.0.0.1:8686', 'http://localhost:8686']
    value['host_ips'] = host_ips if host_ips is not None else value.get('host_ips', [])
    import ipaddress
    for address in value['host_ips']: ipaddress.IPv4Address(address)
    for origin in value['origins']:
        u = urlsplit(origin)
        if not u.hostname or u.username or u.password or u.query or u.fragment or u.path or u.scheme not in ('http', 'https'):
            raise ValueError('Invalid browser origin')
        if u.scheme == 'http' and (u.hostname not in ('localhost','127.0.0.1','::1') or u.port != 8686):
            raise ValueError('HTTP origins are restricted to the development server')
    return value

def write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name+'.new')
    with temporary.open('wb') as handle:
        os.fchmod(handle.fileno(), mode)
        handle.write(data)
        handle.flush(); os.fsync(handle.fileno())
    temporary.replace(path)

def run(*args):
    subprocess.run(args, check=True)

def backup(paths):
    directory = Path('/var/backups/my98-relay') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    directory.mkdir(parents=True, mode=0o700)
    manifest = {}
    for index, path in enumerate(paths):
        if path.is_file():
            name = str(index)+'-'+path.name
            shutil.copy2(path, directory/name)
            os.chmod(directory/name, 0o600)
            manifest[str(path)] = name
    write(directory/'manifest.json', json.dumps(manifest, indent=2).encode(), 0o600)
    print('Backup:', directory)

def nginx_config(text, host):
    # Only edit the HTTPS server for this exact name; preserve IPFS and ACME.
    import re
    for match in re.finditer(r'\bserver\s*\{', text):
        depth=1; end=match.end()
        while depth and end<len(text):
            depth += (text[end]=='{') - (text[end]=='}'); end += 1
        block=text[match.end():end-1]
        if re.search(r'\blisten\s+[^;]*\b443\b[^;]*;', block) and re.search(r'\bserver_name\s+'+re.escape(host)+r'\s*;', block):
            include='    include /etc/my98-relay/nginx.conf;\n'
            if include.strip() in block: return text
            return text[:end-1]+include+text[end-1:]
    raise ValueError('No matching HTTPS nginx server')

def openbsd_login_class(text):
    # Explicit cur/max entries override the inherited daemon class. Generic
    # openfiles/maxproc entries do not override its inherited cur/max values.
    entry = ('my98_relay:\\\n'
             '\t:datasize-cur=256M:datasize-max=512M:\\\n'
             '\t:openfiles-cur=8192:openfiles-max=8192:\\\n'
             '\t:maxproc-cur=64:maxproc-max=64:tc=daemon:\n')
    lines = text.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if line.startswith('my98_relay:')]
    if len(matches) > 1: raise ValueError('Duplicate my98_relay login classes')
    if not matches: return text.rstrip('\n') + '\n\n' + entry
    start = matches[0]; end = start + 1
    while lines[end - 1].rstrip('\n').endswith('\\'):
        if end == len(lines): raise ValueError('Truncated my98_relay login class')
        end += 1
    return ''.join(lines[:start]) + entry + ''.join(lines[end:])

def service(system, action):
    if system == 'Linux':
        if action == 'enable': run('systemctl','enable','--now','my98-relay')
        elif action == 'disable': run('systemctl','disable','--now','my98-relay')
        else: run('systemctl',action,'my98-relay')
    else:
        if action in ('enable','disable'):
            run('rcctl', action, 'my98_relay')
            run('rcctl', 'start' if action=='enable' else 'stop', 'my98_relay')
        else: run('rcctl',action,'my98_relay')

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install','enable','disable'])
    parser.add_argument('--binary', type=Path, help='Native binary, built with libslirp >= 4.8')
    parser.add_argument('--url', help='Exact public WSS URL (install)')
    parser.add_argument('--origin', action='append')
    parser.add_argument('--host-ip', action='append', help='Public NAT/interface address to deny')
    parser.add_argument('--nginx-config', type=Path, help='Existing gateway vhost; back up, validate and reload')
    parser.add_argument('--slirp-libraries', type=Path, help='OpenBSD native libslirp shared libraries from build-relay-openbsd.sh')
    args=parser.parse_args(argv)
    system=platform.system()
    if system not in ('Linux','OpenBSD'): parser.error('Deploy on Debian Linux or OpenBSD')
    if os.geteuid()!=0: parser.error('Installation and activation require root (sudo/doas)')
    os.umask(0o022)
    old=json.loads(CONFIG.read_text()) if CONFIG.exists() else None
    if args.command!='install':
        if old is None: parser.error('Install first')
        backup([CONFIG,Path(old['allow_file'])])
        if args.command=='disable': service(system,'disable')
        old['enabled']=args.command=='enable'
        write(CONFIG,json.dumps(old,indent=2).encode())
        if args.command=='enable': service(system,'enable')
        return
    if not args.binary or not args.binary.is_file() or not args.url: parser.error('install requires --binary and --url')
    config=configuration(args.url,system,old,args.origin,args.host_ip)
    libraries=[]
    if args.slirp_libraries:
        if system!='OpenBSD': parser.error('--slirp-libraries is only for native OpenBSD builds')
        libraries=[p for p in args.slirp_libraries.glob('libslirp.so.*') if p.is_file()]
        if not libraries: parser.error('No native libslirp shared libraries')
    proxy=args.nginx_config.resolve() if args.nginx_config else None
    proxy_text=nginx_config(proxy.read_text(),urlsplit(args.url).hostname) if proxy else None
    binary=Path('/usr/local/lib/my98-relay/my98-relay')
    unit=Path('/etc/systemd/system/my98-relay.service') if system=='Linux' else Path('/etc/rc.d/my98_relay')
    library_path=Path('/usr/local/lib/my98-relay/slirp/lib')
    backup([CONFIG,binary,unit,Path(config['allow_file']),
            *([proxy,Path('/etc/my98-relay/nginx.conf')] if proxy else []),
            *([Path('/etc/rc.conf.local'),Path('/usr/local/lib/my98-relay/supervise.sh')] if system=='OpenBSD' else []),
            *[library_path/p.name for p in libraries]])
    if system=='Linux':
        found=subprocess.run(['id','my98-relay'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
        if not found: run('useradd','--system','--user-group','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','my98-relay')
    else:
        found=subprocess.run(['id','my98-relay'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
        if not found:
            run('groupadd','my98-relay')
            run('useradd','-g','my98-relay','-d','/nonexistent','-s','/sbin/nologin','my98-relay')
    write(binary,args.binary.read_bytes(),0o755)
    for library in libraries: write(library_path/library.name,library.read_bytes(),0o755)
    write(CONFIG,json.dumps(config,indent=2).encode())
    state=Path(config['allow_file']).parent
    state.mkdir(parents=True,exist_ok=True); os.chmod(state,0o700); shutil.chown(state,user='my98-relay',group='my98-relay')
    allow=Path(config['allow_file'])
    if not allow.exists(): write(allow,b'[]\n',0o600)
    os.chmod(allow,0o600); shutil.chown(allow,user='my98-relay',group='my98-relay')
    ops=SOURCE/'src/relay/ops'
    if system=='Linux':
        write(unit,(ops/'my98-relay.service').read_bytes())
        run('systemctl','daemon-reload')
    else:
        write(Path('/usr/local/lib/my98-relay/supervise.sh'),(ops/'supervise.sh').read_bytes(),0o755)
        write(unit,(ops/'my98_relay').read_bytes(),0o755)
        login=Path('/etc/login.conf')
        before=login.read_text(); after=openbsd_login_class(before)
        if before != after:
            backup([login]); write(login,after.encode())
            run('cap_mkdb','/etc/login.conf')
    if proxy:
        write(Path('/etc/my98-relay/nginx.conf'),(ops/'nginx.conf').read_bytes())
        before=proxy.read_bytes(); write(proxy,proxy_text.encode())
        try: run('nginx','-t')
        except subprocess.CalledProcessError:
            write(proxy,before); raise
        run('systemctl','reload','nginx')
    # An upgrade preserves prior opt-in; a fresh install is always disabled.
    service(system,'restart' if config['enabled'] else 'disable')
    print('Relay installed;', 'enabled (prior opt-in preserved).' if config['enabled'] else 'disabled. Activate explicitly with: deploy-relay.py enable')

if __name__=='__main__':
    try: main()
    except (ValueError,OSError,subprocess.CalledProcessError) as error:
        print('Deploy failed:',error,file=sys.stderr); sys.exit(1)
