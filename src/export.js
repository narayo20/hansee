/**
 * 인쇄 및 PDF 저장 기능.
 * 뷰어의 문서/페이지 정보를 받아 브라우저 안에서만 처리한다.
 */
export function createExporter(ctx) {
  let cancelled = false;
  let printStyleEl = null;
  let printGeneration = 0;

  const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  function sanitizeFilename(name) {
    const base = (name || "한글문서").replace(/\.(hwp|hwpx)$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim();
    return base || "한글문서";
  }

  function paperSize() {
    const pages = ctx.getPages();
    const first = pages[0] || { pxW: 794, pxH: 1123 };
    const pxToMm = 25.4 / 96;
    // 0.1mm 단위로 맞춰 A4(210×297mm) 같은 규격 용지가 정확히 인식되게 한다.
    return {
      w: Math.round(first.pxW * pxToMm * 10) / 10,
      h: Math.round(first.pxH * pxToMm * 10) / 10,
    };
  }

  /** 인쇄용 종이 크기를 @page 규칙에 반영한다. */
  function applyPageSize(size) {
    if (!printStyleEl) {
      printStyleEl = document.createElement("style");
      printStyleEl.id = "printPageStyle";
      document.head.appendChild(printStyleEl);
    }
    printStyleEl.textContent = `@page { size: ${size.w}mm ${size.h}mm; margin: 0; }`;
    const root = ctx.getPrintRoot();
    root.style.setProperty("--paper-w", `${size.w}mm`);
    root.style.setProperty("--paper-h", `${size.h}mm`);
  }

  function cleanupPrint() {
    ctx.getPrintRoot().replaceChildren();
    window.removeEventListener("afterprint", cleanupPrint);
  }

  async function print() {
    const doc = ctx.getDoc();
    const pages = ctx.getPages();
    if (!doc || !pages.length) return;

    cancelled = false;
    const root = ctx.getPrintRoot();
    root.replaceChildren();
    applyPageSize(paperSize());

    ctx.showBusy("인쇄할 페이지를 준비하는 중…", { progress: true });
    ctx.setProgress(0, pages.length);

    try {
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < pages.length; i++) {
        if (cancelled) break;

        const sheet = document.createElement("div");
        sheet.className = "print-sheet";
        sheet.innerHTML = ctx.prepareSvg(doc.renderPageSvg(i), `print-${Date.now()}-${i}`);
        fragment.appendChild(sheet);

        ctx.setProgress(i + 1, pages.length);
        if (i % 3 === 0) await nextFrame();
      }

      if (cancelled) {
        root.replaceChildren();
        ctx.hideBusy();
        ctx.toast("인쇄를 취소했습니다.");
        return;
      }

      root.appendChild(fragment);
      await document.fonts?.ready?.catch?.(() => {});
      await wait(140);
      ctx.hideBusy();

      // 데스크톱 앱(WebView2)은 window.print()가 동작하지 않아 네이티브 인쇄 API를 쓴다.
      const desktopPrint = window.pywebview?.api?.print_document;
      if (typeof desktopPrint === "function") {
        printGeneration += 1;
        const generation = printGeneration;
        const ok = await desktopPrint();
        if (ok === false) ctx.toast("인쇄 대화상자를 열지 못했습니다.");
        // WebView2에서는 afterprint가 오지 않으므로 충분한 시간 뒤 인쇄용 DOM을 정리한다.
        setTimeout(() => {
          if (generation === printGeneration) cleanupPrint();
        }, 120000);
      } else {
        window.addEventListener("afterprint", cleanupPrint);
        window.print();
        // window.print()가 즉시 반환하는 브라우저를 위한 정리 예약
        setTimeout(() => {
          if (!root.childElementCount) window.removeEventListener("afterprint", cleanupPrint);
        }, 3000);
      }
    } catch (error) {
      console.error(error);
      root.replaceChildren();
      ctx.hideBusy();
      ctx.toast("인쇄 준비 중 문제가 발생했습니다.");
    }
  }

  /** 캔버스를 흰 배경 위에 평탄화한다(JPEG 투명도 문제 방지). */
  function flattenToWhite(source) {
    const out = document.createElement("canvas");
    out.width = source.width;
    out.height = source.height;
    const g = out.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(source, 0, 0);
    return out;
  }

  async function savePdf() {
    const doc = ctx.getDoc();
    const pages = ctx.getPages();
    if (!doc || !pages.length) return;

    cancelled = false;
    ctx.showBusy("PDF를 만드는 중…", { progress: true, cancel: true });
    ctx.setProgress(0, pages.length);

    let pdf = null;
    try {
      const { jsPDF } = await import("jspdf");

      for (let i = 0; i < pages.length; i++) {
        if (cancelled) break;

        const page = pages[i];
        const naturalWidth = Math.max(page.pxW, 1);
        const scale = Math.min(2, 6200 / naturalWidth);
        const canvas = document.createElement("canvas");

        doc.renderPageToCanvas(i, canvas, scale > 0 ? scale : 1);
        if (!canvas.width || !canvas.height) throw new Error("페이지를 렌더링하지 못했습니다.");

        const flat = flattenToWhite(canvas);
        const data = flat.toDataURL("image/jpeg", 0.92);

        const orientation = page.ptW > page.ptH ? "landscape" : "portrait";
        if (!pdf) {
          pdf = new jsPDF({ orientation, unit: "pt", format: [page.ptW, page.ptH], compress: true });
        } else {
          pdf.addPage([page.ptW, page.ptH], orientation);
        }
        pdf.addImage(data, "JPEG", 0, 0, page.ptW, page.ptH, undefined, "FAST");

        // 메모리 해제
        canvas.width = 0;
        canvas.height = 0;
        flat.width = 0;
        flat.height = 0;

        ctx.setProgress(i + 1, pages.length);
        await wait(0);
      }

      if (cancelled) {
        ctx.hideBusy();
        ctx.toast("PDF 저장을 취소했습니다.");
        return;
      }

      pdf.save(`${sanitizeFilename(ctx.getFileName())}.pdf`);
      ctx.hideBusy();
      ctx.toast("PDF 파일을 저장했습니다.");
    } catch (error) {
      console.error(error);
      ctx.hideBusy();
      ctx.toast("PDF를 만드는 중 문제가 발생했습니다.");
    }
  }

  return {
    print,
    savePdf,
    cancel() {
      cancelled = true;
    },
  };
}
