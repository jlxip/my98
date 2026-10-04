import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/seedbox.py'
class RelayCLI(unittest.TestCase):
    def test_commands_without_kubo_or_subscription_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/'admin.sock')
            listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(path);listener.listen(3)
            calls=[]
            def server():
                for _ in range(3):
                    connection,_=listener.accept()
                    with connection,connection.makefile('rb') as file:
                        calls.append(json.loads(file.readline()))
                        connection.sendall(b'{"ok":true}\n')
            thread=threading.Thread(target=server);thread.start()
            public='ab'*32
            for command,target in [('relay-allow',[public]),('relay-status',[]),('relay-revoke',[public])]:
                result=subprocess.run([sys.executable,str(SCRIPT),command,*target,'--relay-socket',path,'--state',directory+'/unused'],env={**os.environ,'PATH':directory},capture_output=True)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertTrue(json.loads(result.stdout)['ok'])
            thread.join(5);listener.close();self.assertFalse(thread.is_alive())
            self.assertEqual([x['command'] for x in calls],['allow','status','revoke'])
            self.assertFalse(Path(directory,'unused').exists())
    def test_invalid_key_is_rejected_before_connecting(self):
        for public in ['', 'AB'*32, 'z'*64, 'aa'*31]:
            result=subprocess.run([sys.executable,str(SCRIPT),'relay-allow',public,'--relay-socket','/nonexistent'],capture_output=True)
            self.assertEqual(result.returncode,2)
            self.assertIn(b'lowercase hexadecimal public key',result.stderr)

if __name__=='__main__':unittest.main()
