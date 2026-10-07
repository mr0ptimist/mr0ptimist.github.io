import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_local_post import convert_textures


@unittest.skipUnless(os.name == 'nt', 'Windows process-tree cleanup')
class TextureTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='texture-timeout-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'cdp').mkdir()
        (self.root / 'cdp/export_texture_png.js').write_text('''
const fs = require('fs');
const {spawn} = require('child_process');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync(config.pids, JSON.stringify([process.pid, child.pid]));
if (config.invalid_stdout) process.stdout.write('invalid JSON\\n');
setInterval(()=>{},1000);
''', encoding='utf-8')
        self.pids = self.root / 'pids.json'
        self.manifest = self.root / 'textures.json'
        self.manifest.write_text(json.dumps({'pids': str(self.pids)}), encoding='utf-8')
        self.addCleanup(self.cleanup_children)

    def alive(self, pid):
        listing = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'],
                                 capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        return f'"{pid}"'.encode('ascii') in listing.stdout

    def cleanup_children(self):
        if self.pids.exists():
            for pid in json.loads(self.pids.read_text(encoding='utf-8')):
                if self.alive(pid):
                    subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)

    def assert_children_stopped(self):
        pids = json.loads(self.pids.read_text(encoding='utf-8'))
        for pid in pids:
            self.assertFalse(self.alive(pid), f'Conversion-owned process {pid} survived cleanup')

    def timeout_case(self, progress):
        timer = threading.Timer
        run = subprocess.run
        def run_with_short_timeout(command, **kwargs):
            if kwargs.get('timeout') == 600:
                kwargs['timeout'] = 2
            return run(command, **kwargs)
        with patch('publish_local_post.SCRIPT_DIR', self.root), \
             patch('publish_local_post.threading.Timer', side_effect=lambda delay, callback: timer(2, callback)), \
             patch('publish_local_post.subprocess.run', side_effect=run_with_short_timeout):
            with self.assertRaises(subprocess.TimeoutExpired):
                convert_textures(self.manifest, self.root, progress)
        self.assert_children_stopped()

    def test_timeout_removes_spawned_children_with_progress(self):
        self.timeout_case(lambda event: None)

    def test_timeout_removes_spawned_children_without_progress(self):
        self.timeout_case(None)

    def test_invalid_stdout_removes_spawned_children(self):
        self.manifest.write_text(json.dumps({'pids': str(self.pids), 'invalid_stdout': True}), encoding='utf-8')
        with patch('publish_local_post.SCRIPT_DIR', self.root):
            with self.assertRaises(json.JSONDecodeError):
                convert_textures(self.manifest, self.root, lambda event: None)
        self.assert_children_stopped()
