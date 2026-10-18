#!/usr/bin/env python3
"""Build/test the index in isolation; only explicit tool/download caches are shared."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def snapshot(root, destination, tree):
    # write-tree includes staged additions/deletions, never unstaged or ignored files.
    subprocess.run(['git', 'clone', '--quiet', '--shared', '--no-checkout', str(root), str(destination)], check=True)
    git(destination, 'read-tree', tree)
    git(destination, 'checkout-index', '--all')
    revision = git(destination, 'rev-parse', ':vendor/slop86')
    dependency = destination / 'vendor/slop86'
    subprocess.run(['git', 'clone', '--quiet', '--shared', '--no-checkout', str(root / 'vendor/slop86'), str(dependency)], check=True)
    git(dependency, 'checkout', '--quiet', '--detach', revision)
    return tree, revision


def main():
    root = Path(__file__).resolve().parent.parent
    # A Git hook may export an alternate index; snapshot it before clearing Git env.
    tree = git(root, 'write-tree')
    for name in git(root, 'rev-parse', '--local-env-vars').splitlines():
        os.environ.pop(name, None)
    # Preserve the chosen index tree even if this script was called outside the hook.
    parent = root / 'build/ci-runs'
    parent.mkdir(parents=True, exist_ok=True)
    result = Path(tempfile.mkdtemp(prefix='run-', dir=parent))
    print(f'Clean test results: {result}', flush=True)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'site={result / "site"}\ndiagnostics={result}\n')
    env = os.environ.copy()
    # Do not let a caller redirect compilation or fixtures back to their working tree.
    for name in ('CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET_DIR', 'WASM_BINDGEN',
                 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
                 'MAKEFLAGS', 'MFLAGS', 'MAKEFILES'):
        env.pop(name, None)
    env['RUSTUP_TOOLCHAIN'] = '1.89.0'
    with tempfile.TemporaryDirectory(prefix='my98-ci-') as temporary, (result / 'run.log').open('w') as log:
        source = Path(temporary) / 'source'
        _, revision = snapshot(root, source, tree)
        (result / 'source.txt').write_text(f'tree={tree}\nslop86={revision}\n')

        def run(*args):
            print('Clean CI: ' + ' '.join(args), flush=True)
            log.write('$ ' + ' '.join(args) + '\n'); log.flush()
            subprocess.run(args, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)

        try:
            assert not (source / 'build').exists() and not (source / 'node_modules').exists()
            run('rustup', 'toolchain', 'install', '1.89.0', '--profile', 'minimal', '--target', 'wasm32-unknown-unknown')
            run('cargo', 'install', 'wasm-bindgen-cli', '--version', '0.2.100', '--locked', '--root', 'build/crypto-tools')
            run('npm', 'ci')
            run('npx', 'playwright', 'install', *(['--with-deps'] if os.environ.get('GITHUB_ACTIONS') == 'true' else []), 'chromium', 'webkit')
            run('make', 'site-test', 'agent-test')
            shutil.copytree(source / 'build/site', result / 'site')
            print('Clean CI: PASS', flush=True)
        finally:
            for name in ('pages-tests', 'discovery', 'parallel'):
                path = source / 'build' / name
                if path.exists():
                    shutil.copytree(path, result / name)
            log.flush()
            print(f'Log: {result / "run.log"}', flush=True)


if __name__ == '__main__':
    main()
