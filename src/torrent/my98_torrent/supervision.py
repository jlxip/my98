"""Render only named, independently supervised torrent services."""
import os
from pathlib import Path
import pwd
import re
import shlex
from .deployment import SERVICE_USER,nginx_command
from .protocol import PublicationError

MARKER="# Managed by my98 torrent services v1"


def command(arguments):
    return shlex.join(map(str,arguments))


def service_files(config,system,*,isolated=False,prefix="my98-torrent"):
    if not re.fullmatch(r"[a-z][a-z0-9-]+",prefix):raise PublicationError("Invalid service name")
    root=Path(config["root"]);runtime=Path(config["runtime"])
    user=pwd.getpwuid(os.getuid()).pw_name if isolated else SERVICE_USER
    flags=["--isolated"] if isolated else []
    node=[runtime/"bin/my98-torrent","--config",root/"config/node.json",*flags,"serve"]
    helper=[runtime/"bin/my98-torrent-services","--config",root/"config/deployment.json",*flags]
    https=nginx_command(config,"-g","daemon off;")
    files={}
    if system=="Linux":
        ownership="User="+user+"\nGroup="+user+"\n"
        hardening="" if isolated else (
            "NoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\nPrivateTmp=yes\n"
            "ReadWritePaths="+str(root/"data")+"\n")
        common="Environment=PYTHONDONTWRITEBYTECODE=1\nUMask=0077\nKillMode=mixed\nTimeoutStopSec=30\n"+("RuntimeMaxSec=300\n" if isolated else "")
        files[prefix+".service"]=(MARKER+"\n[Unit]\nDescription=my98 torrent follower\n"
            "After=network-online.target\nWants=network-online.target\n"
            "[Service]\nType=simple\n"+ownership+common+hardening+
            "ExecStart="+command(node)+"\nRestart=on-failure\nRestartSec=5\n"
            "LimitNOFILE=8192\n"+("" if isolated else "LimitMEMLOCK=262144000\n")+"MemoryMax=512M\nMemorySwapMax=0\n"
            "OOMPolicy=kill\n[Install]\nWantedBy=multi-user.target\n")
        https_hardening="" if isolated else (
            "NoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\n"
            "ReadWritePaths="+str(root/"nginx")+" "+str(root/"tls")+"\n")
        files[prefix+"-https.service"]=(MARKER+"\n[Unit]\nDescription=my98 dedicated HTTPS and WSS\n"
            "After=network-online.target "+prefix+".service\nWants="+prefix+".service\n"
            "[Service]\nType=simple\n"+common+https_hardening+
            "ExecStart="+command(https)+"\nKillSignal=SIGQUIT\n"
            "ExecReload="+command([*helper,"reload"])+"\nRestart=on-failure\nRestartSec=5\n"
            "LimitNOFILE=8192\nMemoryMax=256M\nMemorySwapMax=0\n[Install]\nWantedBy=multi-user.target\n")
        certificate_hardening="" if isolated else (
            "NoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\nPrivateTmp=yes\n"
            "ReadWritePaths="+str(root/"tls")+" "+str(root/"nginx")+"\n")
        files[prefix+"-certificates.service"]=(MARKER+"\n[Unit]\nDescription=my98 TLS copy renewal\n"
            "After="+prefix+"-https.service\n[Service]\nType=oneshot\n"+common+certificate_hardening+
            "ExecStart="+command([*helper,"renew"])+"\nMemoryMax=128M\n")
        files[prefix+"-certificates.timer"]=(MARKER+"\n[Unit]\nDescription=my98 hourly TLS copy check\n"
            "[Timer]\nOnCalendar=hourly\nPersistent=true\nUnit="+prefix+"-certificates.service\n"
            "[Install]\nWantedBy=timers.target\n")
    elif system=="OpenBSD":
        # The wrappers keep logs in our own directories and exec the real process,
        # so rc.subr's process matching includes the unique runtime/config paths.
        for role,arguments,log in [
            ("node",node,root/"data/node.log"),
            ("https",https,root/"nginx/logs/startup.log"),
            ("certificates",[*helper,"watch-certificates"],root/"nginx/logs/certificates.log")]:
            name=prefix.replace("-","_")+("" if role=="node" else "_"+role)
            launcher=root/"config"/(role+"-launch.sh")
            files["launchers/"+launcher.name]=("#!/bin/sh\n"+MARKER+"\nset -eu\n"
                "export PYTHONDONTWRITEBYTECODE=1\nexec "+command(arguments)+" >> "+shlex.quote(str(log))+" 2>&1\n")
            if role=="node":
                actual=[runtime/"venv/bin/python",runtime/"release/scripts/my98-torrent.py",
                    "--config",root/"config/node.json",*flags,"serve"]
                pattern="^"+re.escape(" ".join(map(str,actual)))+"$"
            elif role=="certificates":
                actual=[runtime/"venv/bin/python",runtime/"release/scripts/my98-torrent-services.py",
                    "--config",root/"config/deployment.json",*flags,"watch-certificates"]
                pattern="^"+re.escape(" ".join(map(str,actual)))+"$"
            else:pattern="^"+re.escape("nginx: master process "+" ".join(map(str,https)))+"$"
            content=("#!/bin/ksh\n"+MARKER+"\ndaemon=/bin/sh\n"
                "daemon_flags="+shlex.quote(str(launcher))+"\n")
            # Root is the rc.subr default. Private unprivileged fixtures run as
            # their caller; public node execution explicitly drops privileges.
            if role=="node" and not isolated:content+="daemon_user="+user+"\n"
            # rc.subr initializes pexp from daemon_flags. Override it after
            # sourcing so runfiles/check/reload/stop match the exec'd process.
            content+=". /etc/rc.d/rc.subr\npexp="+shlex.quote(pattern)+"\nrc_bg=YES\n"
            if role=="https":
                content+="rc_stop_signal=QUIT\nrc_reload() { "+command([*helper,"reload"])+"; }\n"
            else:content+="rc_reload=NO\n"
            content+='rc_cmd "$1"\n'
            files["rc.d/"+name]=content
    else:raise PublicationError("Unsupported service supervisor")
    return files
