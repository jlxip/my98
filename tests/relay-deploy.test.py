import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('deploy',Path(__file__).resolve().parents[1]/'scripts/deploy-relay.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
URL='wss://seeder.example/my98-relay/v1'

class Deploy(unittest.TestCase):
    def test_new_install_is_disabled_empty_authorization_is_separate(self):
        for system,path in [('Linux','/run'),('OpenBSD','/var/run')]:
            config=deploy.configuration(URL,system)
            self.assertIs(config['enabled'],False)
            self.assertEqual(config['admin_socket'],path+'/my98-relay/admin.sock')
            self.assertNotIn('public_key',config)
    def test_upgrade_preserves_explicit_opt_in_and_origins(self):
        old={'enabled':True,'origins':['https://my98.lol'],'host_ips':['1.2.3.4']}
        self.assertEqual(deploy.configuration(URL,'Linux',old)['origins'],old['origins'])
        self.assertIs(deploy.configuration(URL,'Linux',old)['enabled'],True)
        self.assertTrue(old['enabled'])
        with self.assertRaises(ValueError): deploy.configuration(URL,'Linux',origins=['http://public.example:8686'])
        with self.assertRaises(ValueError): deploy.configuration(URL+'?x=1','Linux')
    def test_proxy_edit_preserves_other_vhosts_and_is_idempotent(self):
        old='server { listen 80; server_name seeder.example; }\nserver { listen 443 ssl; server_name other.example; location / { return 404; } }\nserver { listen 443 ssl; server_name seeder.example; location /ipfs/ { proxy_pass http://127.0.0.1:8081; } }'
        new=deploy.nginx_config(old,'seeder.example')
        self.assertEqual(new.count('include /etc/my98-relay/nginx.conf;'),1)
        self.assertIn('server_name other.example; location / { return 404; }',new)
        self.assertIn('location /ipfs/ { proxy_pass http://127.0.0.1:8081; }',new)
        self.assertEqual(deploy.nginx_config(new,'seeder.example'),new)
        with self.assertRaises(ValueError): deploy.nginx_config(old,'unknown.example')
    def test_openbsd_limits_override_inherited_cur_max_and_upgrade_old_class(self):
        old='daemon:\\\n\t:maxproc-cur=128:maxproc-max=256:openfiles-cur=128:openfiles-max=1024:\n'
        obsolete='my98_relay:\\\n\t:datasize-cur=256M:datasize-max=512M:openfiles=8192:maxproc=64:tc=daemon:\n'
        tail='other:\\\n\t:tc=daemon:\n'
        new=deploy.openbsd_login_class(old+obsolete+tail)
        self.assertTrue(new.startswith(old))
        self.assertTrue(new.endswith(tail))
        self.assertIn('openfiles-cur=8192:openfiles-max=8192',new)
        self.assertIn('maxproc-cur=64:maxproc-max=64',new)
        self.assertNotIn('openfiles=8192',new)
        self.assertEqual(new.count('my98_relay:'),1)
        self.assertEqual(deploy.openbsd_login_class(new),new)
        self.assertEqual(deploy.openbsd_login_class(old).count('my98_relay:'),1)

if __name__=='__main__': unittest.main()
