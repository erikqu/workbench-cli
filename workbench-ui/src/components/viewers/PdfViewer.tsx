import { useEffect, useRef, useState } from "react";
import { Box, Text, useBoxRectDangerously, useInput } from "silvery";
import { type PdfPreview, preparePdfPreview } from "../../media/pdf";
import { PdfPageLoader } from "../../media/pdf-page-loader";
import type { EditorTab } from "../../state/types";
import { colors } from "../../ui/theme";
import type { WorkbenchActions, WorkbenchViewModel } from "../types";
import { MeasuredImageContent } from "./ImageViewer";
import { clamp } from "./shared";

export function PdfViewer({
  tab,
  rel,
  view,
  actions,
}: {
  tab: EditorTab;
  rel: string;
  view: WorkbenchViewModel;
  actions: WorkbenchActions;
}) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | undefined>(undefined);
  const focused = view.state.focus === "editor";
  const changePage = (delta: number) => {
    setPage((current) =>
      clamp(current + delta, 1, pageCount ?? Number.MAX_SAFE_INTEGER)
    );
  };

  useInput((_input, key) => {
    if (!focused) {
      return;
    }
    if (key.pageUp || key.upArrow) {
      changePage(-1);
    }
    if (key.pageDown || key.downArrow) {
      changePage(1);
    }
  });

  return (
    <Box
      backgroundColor={colors.editor}
      borderColor={focused ? colors.borderFocus : colors.border}
      borderStyle="single"
      flexDirection="column"
      flexGrow={1}
      minWidth={1}
      onMouseDown={(event) => {
        actions.focus("editor");
        event.stopPropagation();
      }}
      onWheel={(event) => {
        changePage(event.deltaY > 0 ? 1 : -1);
        event.preventDefault();
        event.stopPropagation();
      }}
      padding={1}
    >
      <Box flexDirection="row" height={1} justifyContent="space-between">
        <Text color={colors.dim}>{rel}</Text>
        <Text
          color={colors.dim}
        >{`PDF page ${page}${pageCount ? ` / ${pageCount}` : ""}  ↑↓/PgUp/PgDn`}</Text>
      </Box>
      <Box
        backgroundColor={colors.panelAlt}
        flexGrow={1}
        minWidth={1}
        overflow="hidden"
      >
        <MeasuredPdfContent
          page={page}
          path={tab.path}
          setPage={setPage}
          setPageCount={setPageCount}
        />
      </Box>
    </Box>
  );
}

function MeasuredPdfContent({
  path,
  page,
  setPage,
  setPageCount,
}: {
  path: string;
  page: number;
  setPage(page: number | ((current: number) => number)): void;
  setPageCount(pageCount: number | undefined): void;
}) {
  const rect = useBoxRectDangerously();
  // Small pane drags can reuse the same raster and let the image fit itself.
  const cols = Math.max(1, Math.ceil(rect.width / 8) * 8);
  const [preview, setPreview] = useState<
    (PdfPreview & { sourcePath: string }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef<PdfPageLoader | null>(null);

  useEffect(() => {
    const current = new PdfPageLoader((requestedPage, signal) =>
      preparePdfPreview(path, requestedPage, cols, signal)
    );
    loader.current = current;
    return () => {
      current.dispose();
      loader.current = null;
    };
  }, [path, cols]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loader.current
      ?.load(page)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setPreview({ ...result, sourcePath: path });
        setPageCount(result.pageCount);
        if (result.page !== page) {
          setPage(result.page);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setError(err instanceof Error ? err.message : "Could not render PDF");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, page, cols, setPage, setPageCount]);

  if (error) {
    return <Text color={colors.accentAlt}>{error}</Text>;
  }
  if (!preview || preview.sourcePath !== path || preview.page !== page) {
    return <Text color={colors.dim}>Rendering PDF...</Text>;
  }
  return <MeasuredImageContent path={preview.imagePath} />;
}
