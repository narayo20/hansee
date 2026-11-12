#!/usr/bin/env python3
"""한씨 (Hansee) 로컬 서버.

빌드된 dist 폴더를 127.0.0.1 에서만 제공하고 기본 브라우저를 연다.
외부 네트워크로는 아무것도 전송하지 않는다.
"""

from __future__ import annotations

import argparse
import http.server
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
DEFAULT_PORT = 8765


class ViewerHandler(http.server.SimpleHTTPRequestHandler):
    """WASM/폰트 MIME 타입과 캐시 정책을 보정한 정적 파일 핸들러."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
        ".woff2": "font/woff2",
        ".hwp": "application/octet-stream",
        ".hwpx": "application/octet-stream",
    }

    def end_headers(self) -> None:  # noqa: D401
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        # 콘솔을 깔끔하게 유지한다. 오류만 조용히 무시하지 않고 남긴다.
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("HTTP %s\n" % (args[1],))


def find_port(host: str, start: int) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    raise SystemExit("사용 가능한 포트를 찾지 못했습니다.")


def main() -> int:
    parser = argparse.ArgumentParser(description="한씨 로컬 서버")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="사용할 포트 (기본: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = parser.parse_args()

    if not (DIST / "index.html").exists():
        print("빌드된 앱이 없습니다.")
        print("다음 명령으로 먼저 빌드해 주세요:\n")
        print("  npm install")
        print("  npm run build\n")
        return 1

    host = "127.0.0.1"
    port = find_port(host, args.port)
    url = f"http://{host}:{port}/"

    handler = lambda *a, **kw: ViewerHandler(*a, directory=str(DIST), **kw)  # noqa: E731
    server = http.server.ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True

    print("=" * 52)
    print("  한씨 (Hansee)  ·  HWP / HWPX")
    print("=" * 52)
    print(f"  주소: {url}")
    print("  종료: 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.")
    print()

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n한씨를 종료합니다.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
