import functools
import http.server
import json
import shutil
import subprocess
import threading
import unittest
from pathlib import Path
from urllib.parse import quote

import test_publish_local_post as fixtures


class PublicationDestinationUITests(unittest.TestCase):
    def test_both_destinations_have_matching_sizes_and_bidirectional_links(self):
        fixture = fixtures.PublishLocalPostTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        source = fixture.source / 'index.md'
        source.write_text(source.read_text(encoding='utf-8').replace('draft = true', "draft = true\nslug = 'paired-entry'"), encoding='utf-8')
        fixture.assert_success(fixture.run_publish())
        shutil.copytree(fixture.root / 'content/posts', fixture.root / 'content/protect')
        protected = fixture.root / 'content/protect' / fixture.target.relative_to(fixture.root / 'content/posts')
        (protected / 'additional.txt').write_text('protect-only attachment', encoding='utf-8')
        project = Path(__file__).resolve().parents[2]
        config = "title='test'\nbaseURL='/'\ntheme='PaperMod'\n"
        for option, directory in [('themesDir', 'themes'), ('layoutDir', 'layouts'), ('assetDir', 'assets'), ('staticDir', 'static')]:
            config += f"{option}='{(project / directory).as_posix()}'\n"
        config += f"[params]\nvscodeContentBase='{fixture.root.as_posix()}'\nlocalPublishAPI='/'\n"
        (fixture.root / 'hugo.toml').write_text(config, encoding='utf-8')
        site = fixture.root / 'site'
        build = subprocess.run(['hugo', '--source', str(fixture.root), '--destination', str(site),
                                '--environment', 'development', '-D', '--quiet'], capture_output=True, text=True,
                               encoding='utf-8', timeout=120)
        self.assertEqual(build.returncode, 0, build.stdout + build.stderr)
        route = next(p for p in (site / 'local').rglob('index.html') if p.parent.name == 'paired-entry').relative_to(site)

        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == '/session':
                    data = json.dumps({'token': 'fixture-token', 'destinations': ['public', 'protect']}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                file = Path(self.translate_path(self.path))
                if self.headers.get('Range') == 'bytes=0-147' and file.suffix.lower() == '.dds' and file.is_file():
                    data = file.read_bytes()[:148]
                    self.send_response(206)
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Content-Range', f'bytes 0-{len(data)-1}/{file.stat().st_size}')
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    super().do_GET()

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(site)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sizes = [str(sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())) for folder in (fixture.target, protected)]
            result = subprocess.run(['node', str(project / 'scripts/cdp/publish_viewer_check.js'),
                                     f'http://127.0.0.1:{server.server_port}/{quote(route.parent.as_posix())}/', '--destinations', *sizes, '--draft-dialog'],
                                    capture_output=True, text=True, encoding='utf-8', timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
