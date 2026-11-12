#!/usr/bin/env python3
"""한씨 (Hansee) 데스크톱 실행기.

빌드된 `dist` 폴더를 127.0.0.1 에서만 제공하고, WebView2 창에 표시한다.
PyInstaller 로 감싸면 `한씨.exe` 하나로 실행할 수 있다.
"""

from __future__ import annotations

import argparse
import ctypes
import functools
import http.server
import logging
import sys
import tempfile
import threading
from pathlib import Path


APP_NAME = "한씨"
BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
DIST = BASE_DIR / "dist"
LOG_PATH = Path(tempfile.gettempdir()) / "hansee.log"


def setup_logging() -> None:
    logging.basicConfig(
        filename=str(LOG_PATH),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        encoding="utf-8",
    )


def show_error(message: str) -> None:
    logging.error(message)
    try:
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    except Exception:  # pragma: no cover - 콘솔 없는 환경 보호
        pass


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
    }

    def end_headers(self) -> None:  # noqa: D401
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path):  # noqa: ANN001, D401
        self.send_error(404)
        return None

    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        logging.debug("%s - %s", self.address_string(), fmt % args)


class DesktopApi:
    """자바스크립트에서 호출하는 데스크톱 전용 기능 모음."""

    def print_document(self) -> bool:
        """WebView2 네이티브 인쇄 대화상자를 연다.

        WebView2 에서는 `window.print()` 가 동작하지 않기 때문에, UI 스레드에서
        `CoreWebView2.ShowPrintUI` 를 직접 호출한다.
        """

        try:
            import webview
            from Microsoft.Web.WebView2.Core import CoreWebView2PrintDialogKind
            from System import Func, Object
            from webview.platforms import winforms

            window = next(iter(webview.windows), None)
            if window is None:
                return False

            form = winforms.BrowserView.instances.get(window.uid)
            if form is None or form.webview is None:
                return False

            # CoreWebView2 는 UI 스레드에서만 접근할 수 있으므로 확인과 호출을 모두 넘긴다.
            state = {"opened": False}

            def open_dialog() -> None:
                try:
                    core = form.webview.CoreWebView2
                    if core is not None:
                        core.ShowPrintUI(CoreWebView2PrintDialogKind.System)
                        state["opened"] = True
                except Exception:
                    logging.exception("ShowPrintUI failed")

            form.webview.Invoke(Func[Object](open_dialog))
            if state["opened"]:
                logging.info("native print dialog requested")
            return state["opened"]
        except Exception:
            logging.exception("print dialog failed")
            return False


def start_server(port: int) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(ViewerHandler, directory=str(DIST))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="viewer-http", daemon=True)
    thread.start()
    return server


def main() -> int:
    setup_logging()

    parser = argparse.ArgumentParser(description="한씨 데스크톱 실행기")
    parser.add_argument("--port", type=int, default=0, help="로컬 서버 포트 (기본: 자동)")
    parser.add_argument("--no-ui", action="store_true", help="창 없이 서버만 실행 (테스트용)")
    args = parser.parse_args()

    if not (DIST / "index.html").exists():
        show_error("앱 파일을 찾을 수 없습니다.\n빌드된 dist 폴더가 필요합니다.")
        return 1

    try:
        server = start_server(args.port)
    except OSError as error:
        show_error(f"로컬 서버를 시작하지 못했습니다.\n{error}")
        return 1

    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    logging.info("server started: %s", url)

    if args.no_ui:
        print(url, flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            server.server_close()
        return 0

    try:
        import webview

        webview.create_window(
            APP_NAME,
            url,
            width=1360,
            height=900,
            min_size=(900, 600),
            text_select=True,
            background_color="#f3f5fa",
            js_api=DesktopApi(),
        )
        webview.start()
    except Exception as error:  # pragma: no cover - 패키징 환경 오류 안내
        logging.exception("WebView2 window failed")
        show_error(
            "앱 창을 열지 못했습니다.\n"
            "Microsoft Edge WebView2 런타임이 설치되어 있는지 확인해 주세요.\n\n"
            f"{error}"
        )
        return 1
    finally:
        server.shutdown()
        server.server_close()
        logging.info("server stopped")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
